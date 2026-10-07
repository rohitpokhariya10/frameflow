/**
 * Reusable template families: the STRUCTURE of a creative (where its product, people, text and badges sit and how they
 * relate) kept apart from its CONTENT (which product, which colours, which words). One family is one reusable
 * structure; its blueprint versions say how to generate and decompose any creative with that structure. Pure types,
 * no React, no Node. See docs/TEMPLATE_FAMILIES.md.
 */

/** Structural roles. A role says what a region does in the layout, never what it shows. */
export const STRUCTURAL_ROLES = ['background', 'product', 'person', 'headline', 'subheadline', 'body', 'price', 'offer', 'cta', 'badge', 'logo', 'frame', 'panel', 'decoration', 'object'] as const;
export type StructuralRole = typeof STRUCTURAL_ROLES[number];

/** What kind of background the creative has: structural (it changes how it is decomposed), never its colour. */
export const BACKGROUND_KINDS = ['flat', 'gradient', 'photo', 'illustrated', 'pattern', 'unknown'] as const;
export type BackgroundKind = typeof BACKGROUND_KINDS[number];

/** Fractions of the canvas (0..1): top-left corner, width and height. The same family fits every aspect ratio. */
export interface NormalizedBox { x: number; y: number; width: number; height: number }

/** One structural element: its role and its normalized box. No label, no text, no colour. */
export interface StructuralElement { id: string; role: StructuralRole; box: NormalizedBox; z: number }

/** Semantic relations geometry cannot show. Above/below/left/right are derived from the boxes (signature.ts). */
export const SEMANTIC_RELATIONS = ['holds', 'wears', 'attached_to', 'inside', 'on'] as const;
export type SemanticRelationType = typeof SEMANTIC_RELATIONS[number];
export interface StructuralRelation { from: string; to: string; type: SemanticRelationType }

/** The structural identity of a creative. Elements exclude the background, which is `background`. */
export interface StructuralSignature {
  version: 1;
  background: BackgroundKind;
  elements: StructuralElement[];
  relations: StructuralRelation[];
}

/**
 * What one image actually shows, per element and for the background: instance content. It belongs to that image only
 * and is never written into a blueprint (it would make every later creative say "headphones").
 */
export interface InstanceContent {
  elements: Record<string, { label: string; text: string }>;
  background: string;
}

/** The result of a structural analysis of one image (cheap or strong planner, or a seed): structure and content apart. */
export interface StructureAnalysis {
  signature: StructuralSignature;
  instance: InstanceContent;
  /** A structural name ("Centered Product Offer"), checked to contain no instance words. */
  layoutName: string;
  /** The legacy decomposition recipe whose local post-processing fits this structure. */
  decompositionRecipe: DecompositionRecipe;
  /** The planner's own confidence, 0..1. */
  confidence: number;
}

/** The local post-processing recipes the decomposition runner already has (layerizeTemplates.ts). Data, not branches. */
export const DECOMPOSITION_RECIPES = ['template-a', 'template-b', 'template-c'] as const;
export type DecompositionRecipe = typeof DECOMPOSITION_RECIPES[number];

/** Slot kinds the form renders. Native kinds can be changed as editor layers without a new image. */
export const SLOT_KINDS = ['product', 'person', 'text', 'cta', 'offer', 'logo', 'background', 'decoration', 'object'] as const;
export type SlotKind = typeof SLOT_KINDS[number];

/** One field a user may change. Derived from the structure; the form is rendered from these, never hand-written. */
export interface BlueprintSlot {
  id: string;
  kind: SlotKind;
  /** The layout element it fills (absent for the background slot). */
  elementId?: string;
  role: StructuralRole;
  label: string;
  /** Generic help ("e.g. wireless earbuds"): never the content of an earlier creative. */
  placeholder: string;
  required: boolean;
  editable: boolean;
  /** Changing it needs no new image: it is text or a logo the editor can replace as a layer. */
  nativeEditable: boolean;
  maxLength: number;
  expectedRegion?: NormalizedBox;
  parentRelationship?: { type: SemanticRelationType; target: string };
  /** Empty: keep what the reference shows. */
  defaultValue: string;
}

/** One expected editor layer of the decomposition plan template. Descriptions use {{slot}} placeholders only. */
export interface PlanElementTemplate {
  id: string;
  /** Semantic-planner type ("product", "headline text", "background"). */
  type: string;
  role: StructuralRole;
  slotId?: string;
  descriptionTemplate: string;
  region: string;
  z: number;
  /** Required: a reused decomposition without it is not accepted as is. */
  required: boolean;
  attachment?: { relation: 'held_in_hand' | 'worn_by_human' | 'attached_to_human' | 'part_of_object'; parent: string; separationRisk: 'low' | 'medium' | 'high'; keepWithParent: boolean };
}

export interface DecompositionPlanTemplate {
  version: 1;
  imageType: string;
  elements: PlanElementTemplate[];
  /** Fixed, structural instructions that keep billable raw layers down (no shadow / glow / confetti layers). */
  exclusions: string;
  /** Background handling: one clean plate, or a photographic scene kept whole. */
  backgroundPolicy: 'clean-plate' | 'scene-plate';
}

export interface CurationPolicy {
  /** The editor layer count a good result of this family has (including the background). */
  expectedEditorLayers: { min: number; max: number };
  /** Raw provider layers above this mean the plan was not followed. */
  maxRawLayers: number;
}

/** One immutable version of a family. Runs record { familyId, version }; a new strategy is a new version. */
export interface TemplateBlueprint {
  familyId: string;
  version: number;
  name: string;
  /** Short quantized identity (signature.ts signatureKey), for dedup and display. */
  signatureKey: string;
  pattern: string;
  signature: StructuralSignature;
  slots: BlueprintSlot[];
  /** Instructions for image generation with {{slot}} placeholders, compiled locally with the current values. */
  generationPromptTemplate: string;
  decompositionPlanTemplate: DecompositionPlanTemplate;
  expectedLayerRoles: StructuralRole[];
  groupingRules: string[];
  curationPolicy: CurationPolicy;
  decompositionRecipe: DecompositionRecipe;
  supportedRatios: string[];
  promptVersion: number;
  createdAt: string;
  /** Why this version exists ("seed", "detected from upload", "developer revision"). */
  origin: string;
}
export interface BlueprintRef { familyId: string; version: number }
export const blueprintRefText = (ref: BlueprintRef) => `${ref.familyId}@v${ref.version}`;

/** An image whose structure was analyzed and confirmed for this family: the evidence local matching uses. */
export interface FamilyExemplar {
  id: string; addedAt: string; sha256: string; source: 'analysis' | 'seed';
  /** The image-template group it came from, when it can be reused as a starting creative. */
  groupId?: string;
  signature: StructuralSignature;
  fingerprint?: LayoutFingerprint;
}

/** A cheap, local, role-less layout fingerprint of an image (server: sharp). Geometry of foreground regions only. */
export interface LayoutFingerprint {
  version: 1;
  aspect: number;
  background: 'plain' | 'complex';
  /** 0..1: how far the foreground mask can be trusted (low on photographic backgrounds). */
  reliability: number;
  coverage: number;
  /** Largest first. On an analyzed exemplar each region carries the element (and role) its centre falls in. */
  regions: { box: NormalizedBox; area: number; role?: StructuralRole; element?: string }[];
  /** 8×8 foreground occupancy, row-major, 0..1. */
  occupancy: number[];
}

export interface CallStat { calls: number; usd: number }
/** Usage and quality numbers. Collected, never used to rewrite prompts (developers tune new versions from them). */
export interface FamilyStats {
  matches: number; rejectedMatches: number; confidenceSum: number; created: number;
  generationSuccess: number; generationFailure: number;
  decompositionSuccess: number; decompositionFailure: number; reuseValidationFailures: number; manualReplans: number;
  rawLayers: number; editorLayers: number; decompositionsMeasured: number;
  residualCalls: number; backgroundEditCalls: number;
  totalUsd: number; costedRuns: number;
  /** Observed cost of the calls reuse avoids, from this family's own novel-path calls: the saving baseline. */
  observed: { analysis: CallStat; planner: CallStat };
  lastUsedAt?: string;
}
export type FamilyStatus = 'provisional' | 'active' | 'retired';
/** A family as the library keeps it: its versions, examples and statistics. */
export interface TemplateFamily {
  id: string; name: string; status: FamilyStatus;
  currentVersion: number; versions: number[];
  seed?: { key: string; revision: number };
  createdAt: string; updatedAt: string;
  /** Why it became active: seeded, or the run whose full plan agreed with the blueprint's plan. */
  activatedBy?: string;
  exemplars: FamilyExemplar[];
  examples: { groupId: string; at: string; method: MatchMethod; confidence: number }[];
  stats: FamilyStats;
  failures: { at: string; groupId?: string; runId?: string; reason: string }[];
}

export type MatchMethod = 'cached-analysis' | 'local-fingerprint' | 'cheap-planner' | 'strong-planner' | 'library';
export interface MatchCandidate { familyId: string; name: string; version: number; score: number; stage: 'local' | 'structure'; problems: string[] }
export interface MatchValidation { passed: boolean; problems: string[] }

/**
 * What a decomposition run reused from its family, recorded on the run (run.json `templateReuse`). Call counts are the
 * calls actually made for this creative: telemetry never claims a saving for a call that was made.
 */
export interface TemplateReuseRecord {
  familyId: string; familyName: string; version: number;
  matchMethod: MatchMethod; matchConfidence: number;
  analysisReused: boolean; generationPromptTemplateReused: boolean; decompositionPlanReused: boolean;
  /** Structural analysis calls made to detect this creative's family (cheap + strong). */
  structuralPlannerCalls: number; cheapPlannerCalls: number; strongPlannerCalls: number;
  /** Calls avoided because a saved analysis / plan was reused. */
  avoided: { analysis: number; planner: number };
  /** Why the plan was not reused (a provisional family, the user asked to plan afresh, a generated image that drifted). */
  planNotReusedReason?: string;
  /** A generated image only: the local check of its layout against the family before the plan was reused (no call). */
  imageValidation?: MatchValidation;
  /** After the run: whether the reused plan's result passed the quality gate. */
  validation?: MatchValidation & { checkedAt: string; rawLayers?: number; editorLayers?: number };
  statsRecorded?: boolean;
}
