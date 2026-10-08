/**
 * Creative templates: reusable decomposition recipes learned from a user's first creative of a structure, stored, and
 * reused for later creatives with the same structure. A template is NOT a predefined category: the library starts empty
 * and only holds what users created. Its identity is its id and version, nothing else.
 *
 * Everything a template version keeps is role-based (roles.ts). The source image's content stays in its own run and
 * execution history.
 */
import type { TemplateRelation, TemplateRole, TemplateZone } from './roles.js';

/** One layer of a template's structure: what it does, never what it shows. */
export interface TemplateLayer {
  /** A role-based id, unique in the template ("primary_subject", "cta_2"). */
  id: string;
  role: TemplateRole;
  /** Back to front, from 0. */
  order: number;
  /** Its own editable layer, or kept in its parent's layer. */
  independent: boolean;
  /** Expected in every creative of this template. */
  required: boolean;
  /** How it hangs on another layer (a held object on its subject, a worn item on its wearer). */
  attachment?: { relation: 'held_in_hand' | 'worn_by_human' | 'attached_to_human' | 'part_of_object'; parent: string; keepWithParent: boolean; separationRisk: 'low' | 'medium' | 'high' };
  /** Layers in front of it, and whether its hidden part is rebuilt when it moves. */
  occlusion?: { occludedBy: string[]; requiresReconstruction: boolean };
  /** Coarse place on the canvas; absent when the planner's region gave none. */
  zone?: TemplateZone;
}
export interface TemplateRelationship { source: string; relation: TemplateRelation; target: string }
export interface TemplateStructure { layers: TemplateLayer[]; relationships: TemplateRelationship[] }

/** The reusable decomposition plan: a role-based instruction for the layer model, compiled into a run without the planner. */
export interface TemplatePlan {
  /** How the creative is split, in role words. */
  strategy: string;
  /** The instruction the layer model receives (role words; at most the provider's prompt limit). */
  prompt: string;
  /** Independent layers the plan asks for, including the background. */
  recommendedLayers: number;
  /** The instruction says where a layer continues behind the layers in front of it (its saved occlusion). Versions saved
   * before this existed keep the wording they were saved with. */
  occlusionWording?: boolean;
}
/** The reusable instruction of an image edit: role-based, with the user's change filled in at execution time. */
export interface GenerationPromptTemplate {
  /** Contains EDIT_INSTRUCTION_SLOT exactly once. */
  text: string;
}
export const EDIT_INSTRUCTION_SLOT = '{{edit_instruction}}';
/** Generic decomposition settings of a template (no predefined recipe): the run options its executions use. */
export interface TemplateDecompositionConfig {
  /** The recursive cleanup after the first pass: residual passes and a clean background, only while needed. */
  refinement: boolean;
  /** Editor layers a good decomposition of this structure ends with (its quality check after a reuse). */
  expectedEditorLayers: { min: number; max: number };
}

/** One immutable version of a template. Executions record the version they used; a later version never changes them. */
export interface TemplateVersion {
  templateId: string;
  version: number;
  createdAt: string;
  name: string;
  description: string;
  structure: TemplateStructure;
  plan: TemplatePlan;
  generationPrompt: GenerationPromptTemplate;
  decomposition: TemplateDecompositionConfig;
  /** Where it was learned: the creating execution and its run (whose history keeps the source image's content). */
  source: { executionId: string; runId: string; plannerModel: string };
  /** A later version: which version it was made from, and how (edited settings, or a new plan of the source image). */
  derivedFrom?: { version: number; reason: 'settings' | 'replan'; at: string; change: string };
}
/** Roles whose layer the user may keep separate or fold into another (backdrops, decorations, props, effects, companions). */
export const SEPARABLE_ROLES: readonly TemplateRole[] = ['backdrop', 'decoration', 'prop', 'effect', 'supporting_product'];
/** A plan-settings edit: it always becomes a new version, so runs of earlier versions keep theirs. */
export interface TemplateSettingsChange {
  refinement?: boolean;
  expectedEditorLayers?: { min: number; max: number };
  /** Layer id → its own layer (true) or kept with the background or main product (false). Separable roles only. */
  separateLayers?: Record<string, boolean>;
}
/** Whether a template's saved plan still names every layer its creatives show, from its runs' own evidence. */
export interface TemplateHealth {
  status: 'ok' | 'plan-incomplete' | 'unknown';
  issues: string[];
  /** Runs whose decomposition was read for this verdict. */
  checkedRuns: number;
}
export type TemplateStatus = 'active' | 'deleted';
/** A template as listed: its current version's summary, and how often it was reused. */
export interface CreativeTemplate {
  id: string;
  name: string;
  description: string;
  status: TemplateStatus;
  currentVersion: number;
  versions: number[];
  /** The roles of its current version, back to front (for cards and the reuse form). */
  layerRoles: TemplateRole[];
  /** The source creative's thumbnail file in the template's folder. */
  thumbnail?: string;
  createdAt: string;
  updatedAt: string;
  stats: { reuses: number; edits: number; lastUsedAt?: string };
}
