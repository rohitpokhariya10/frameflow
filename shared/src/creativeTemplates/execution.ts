import type { TemplateStructure } from './types.js';
import type { BlueprintCompatibility, TemplateEditOptions } from './editPlan.js';
import type { SemanticVerification } from './verification.js';
import type { VariantLayer } from './variants.js';
/**
 * Automatic inspection resolves a saved-template or fresh-planner execution mode. The backend enforces that mode's
 * planner/image policy; the UI shows it. The optional preceding structure-analysis call is counted in `inspection`.
 *
 *   CREATE_TEMPLATE            planner 1 (it also returns the reusable plan and prompt), image generation 0,
 *                              decomposes the upload, saves a template version on success
 *   REUSE_TEMPLATE_ORIGINAL    planner 0, analysis 0, image generation 0, decomposes the upload with the saved plan
 *   REUSE_TEMPLATE_WITH_EDIT   planner 0, analysis 0, image edit 1, decomposes the edited image with the saved plan
 */

export const EXECUTION_MODES = ['CREATE_TEMPLATE', 'REUSE_TEMPLATE_ORIGINAL', 'REUSE_TEMPLATE_WITH_EDIT'] as const;
export type ExecutionMode = typeof EXECUTION_MODES[number];
export const isExecutionMode = (value: unknown): value is ExecutionMode => (EXECUTION_MODES as readonly unknown[]).includes(value);

export interface ExecutionPolicy {
  /** The GPT decomposition planner. */
  planner: boolean;
  /** A separate image-understanding / prompt-writing call (never needed: creation gets its prompt template from the planner). */
  promptGeneration: boolean;
  /** An image generation or edit call. */
  imageGeneration: boolean;
  /** What is decomposed. */
  decomposes: 'upload' | 'edited-image';
  /** The execution saves a new template on success. */
  createsTemplate: boolean;
}
export const EXECUTION_POLICY: Readonly<Record<ExecutionMode, Readonly<ExecutionPolicy>>> = {
  CREATE_TEMPLATE: { planner: true, promptGeneration: false, imageGeneration: false, decomposes: 'upload', createsTemplate: true },
  REUSE_TEMPLATE_ORIGINAL: { planner: false, promptGeneration: false, imageGeneration: false, decomposes: 'upload', createsTemplate: false },
  REUSE_TEMPLATE_WITH_EDIT: { planner: false, promptGeneration: false, imageGeneration: true, decomposes: 'edited-image', createsTemplate: false },
};

export type ExecutionState = 'detecting' | 'ready' | 'queued' | 'generating' | 'generated' | 'planning' | 'decomposing' | 'saving' | 'done' | 'failed';
/** What the user is told each state is doing, per mode: never a step the mode does not take. */
export const EXECUTION_STEP_LABELS: Record<ExecutionMode, Partial<Record<ExecutionState, string>>> = {
  CREATE_TEMPLATE: { queued: 'Waiting for the previous decomposition…', planning: 'Analyzing creative and planning decomposition…', decomposing: 'Decomposing layers…', saving: 'Saving template…', done: 'Template saved', failed: 'Template not created' },
  REUSE_TEMPLATE_ORIGINAL: { queued: 'Loading template…', decomposing: 'Reusing saved decomposition plan · decomposing image…', done: 'Decomposed with the saved plan', failed: 'Decomposition failed' },
  REUSE_TEMPLATE_WITH_EDIT: { queued: 'Loading template…', generating: 'Generating creative…', generated: 'Creative ready for review', decomposing: 'Reusing saved decomposition plan · decomposing image…', done: 'Edited and decomposed with the saved plan', failed: 'Failed' },
};

/** The calls an execution made, as counted when made: the evidence that reuse skipped the planner. */
export interface ExecutionUsage {
  plannerCalled: boolean;
  promptGenerationCalled: boolean;
  imageGenerationCalled: boolean;
  plannerCalls: number;
  imageGenerationCalls: number;
  plannerModel?: string;
  imageModel?: string;
  /**
   * Where the generation prompt came from: the creating planner call, the template's saved prompt, a resolved change
   * plan of the image's own analysis, a creative variant's scene, or none needed.
   */
  generationPromptSource: 'planner' | 'saved-template' | 'resolved-plan' | 'creative-variant' | 'none';
  /** Where the decomposition plan came from: the planner, or the template's saved plan. */
  decompositionPlanSource: 'planner' | 'saved-template';
  timings: { generationMs?: number; decompositionMs?: number; totalMs?: number };
  /** Smart edits and creative variants: the paid calls that came before generation, and the check after it, counted apart. */
  analysisCalls?: number; resolutionCalls?: number; verificationCalls?: number;
  verifierModel?: string;
}
export interface ExecutionImage { file: string; mimeType: string; width: number; height: number; bytes: number; sha256: string }
/**
 * What the local review of a generated creative found: pixel comparisons of the input and the result, never a semantic
 * judgment. A check can show that a region still looks like the original; none can confirm that a new product is right.
 */
export interface GenerationReviewCheck {
  id: 'object-unchanged' | 'unrequested-change' | 'image-unchanged' | 'region-unknown' | 'semantic' | 'cutout-limitation';
  slotId?: string; label?: string; severity: 'warning' | 'info'; message: string; evidence: Record<string, number>;
}
export interface GenerationReview {
  /**
   * Where the requested regions came from: the template's own source layers, its coarse zones, the analysis's approximate
   * boxes, nowhere (whole image), or a creative variant (its subject is exact source pixels by construction).
   */
  method: 'source-layer-masks' | 'template-zones' | 'analysis-boxes' | 'whole-image' | 'creative-variant';
  checks: GenerationReviewCheck[];
  /** Any warning: decomposition waits for an explicit "use it anyway". */
  requiresAcknowledgement: boolean;
  note: string;
  acknowledgedAt?: string;
  /** The AI vision check, when one was asked for: its own status, never folded into a pass. */
  semantic?: SemanticVerification;
}
/**
 * Which plan an extraction uses: the template's saved plan, a simpler grouping of it (no call), or a refreshed plan (one
 * planner call). A creative variant also has its own composed layers (no extraction at all), and its simple and
 * refreshed plans split only the new scenery, never its exact subject.
 */
export type ExtractionPlan = 'saved' | 'simple' | 'refresh' | 'composed';
export const EXTRACTION_PLANS: readonly ExtractionPlan[] = ['saved', 'simple', 'refresh', 'composed'];
export interface TemplateExecution {
  id: string;
  /** The original submission was automatic inspection; remains stable for retry deduplication. */
  automatic?: boolean;
  /** The wizard pauses after its image call until the user accepts the saved creative. Older API clients keep their flow. */
  reviewBeforeDecompose?: boolean;
  imageAcceptedAt?: string;
  slotValues?: Record<string, string>;
  /** How the fields were meant (replace or change the main product, its brand, whether its companions stay). */
  editOptions?: TemplateEditOptions;
  /** Whether the saved decomposition plan still describes the creative after the requested changes (editPlan.ts). */
  compatibility?: BlueprintCompatibility;
  /** The user's explicit choice of plan for extraction, when one was needed or asked for. */
  planDecision?: { choice: ExtractionPlan; at: string; reasons?: string[] };
  /** Earlier extractions of this execution's image that did not finish (each a separate provider request). */
  extractionAttempts?: { runId: string; plan: ExtractionPlan; error?: { code: string; message: string }; at: string }[];
  mode: ExecutionMode;
  inspection?: TemplateInspection;
  plannerReason?: 'new-structure' | 'plan-fresh';
  /** A new plan of a saved template's source image, saved as that template's next version (never a new template). */
  updatesTemplate?: { id: string; fromVersion: number };
  /** The client's key for this submission: the same key never starts a second execution. */
  idempotencyKey: string;
  state: ExecutionState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Reuse: the template version used, pinned when the execution starts. Create: the template saved, once saved. */
  template?: { id: string; name: string; version: number };
  upload: ExecutionImage & { originalName?: string };
  /** A reuse with an edit: the user's instruction, the prompt sent and the edited image. */
  edit?: { instruction: string; prompt: string; model: string; size: string; image?: ExecutionImage; requestFile?: string; responseFile?: string; durationMs?: number;
    /** An optional image of the new product, sent as the edit's second input image. */
    reference?: ExecutionImage;
    /** The local review of the generated image (heuristics); decomposition waits on its warnings. */
    review?: GenerationReview };
  runId?: string;
  usage: ExecutionUsage;
  warnings: string[];
  error?: { code: string; message: string; state: ExecutionState };
  /** The finished decomposition opened in the editor. */
  editor?: { runId: string; openedAt: string };
  /** A smart edit: the persisted resolution it was generated from, verified against its exact inputs before the call. */
  resolution?: { id: string; analysisId: string; summary: string; changes: number; inferred: number };
  /** A chosen creative variant: its set, and its exact layers (the subject is source pixels; the scenery is new). */
  variant?: { setId: string; variantId: string; layers: { scenery: ExecutionImage; plate: ExecutionImage; shadow?: VariantLayer; subject: VariantLayer }; protectedLabels: string[] };
}

/** What a decomposition run records about the execution it belongs to (run.json `templateExecution`). */
export interface RunTemplateExecution {
  executionId: string;
  mode: ExecutionMode;
  /** The plan this extraction used, and whether the user explicitly asked for a fresh plan (the only planner call a reuse may make). */
  plan?: ExtractionPlan;
  planRefresh?: boolean;
  /** Exactly which image was decomposed, checked against the execution's record before anything was sent. */
  input?: { source: 'approved-generated' | 'original-upload' | 'variant-scenery'; sha256: string };
  inspection?: TemplateInspection;
  plannerReason?: 'new-structure' | 'plan-fresh';
  template?: { id: string; name: string; version: number };
}

/** Reuse telemetry of a run, as its dashboard shows it. Calls avoided are never counted when they were made. */
export interface ExecutionTelemetry extends RunTemplateExecution {
  plannerCalled: boolean;
  promptGenerationCalled: boolean;
  imageGenerationCalled: boolean;
  generationPromptSource: ExecutionUsage['generationPromptSource'];
  decompositionPlanSource: ExecutionUsage['decompositionPlanSource'];
  plannerCallsAvoided: number;
}

/** Evidence belongs to this upload, while reusable versions keep only structural roles. */
export interface TemplateInspection {
  outcome: 'exact' | 'strong' | 'compatible' | 'uncertain' | 'new';
  confidence?: number;
  reason: string;
  structure?: TemplateStructure;
  currentValues: Record<string, string>;
  calls: number;
  model?: string;
  durationMs?: number;
  requestFile?: string;
  responseFile?: string;
}
