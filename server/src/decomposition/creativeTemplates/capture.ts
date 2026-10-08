/**
 * A new template version from a finished CREATE_TEMPLATE run: its planner's semantic analysis and template capture
 * (one call), turned into structure only. Every element becomes a role-based layer (primary_subject, held_object…), every
 * relation a role relation, and every reusable text is built from roles in code (compile.ts). The planner's own name and
 * description of the composition are kept only when they carry none of this image's content words; otherwise a
 * structural name replaces them. What the image showed stays in the run's own history (run.json, plan.json).
 */
import { canonicalStructure, contentWords, isTemplateRole, leakedContent, TEMPLATE_ROLE_LABELS, TEMPLATE_ZONES, templateRelation, type TemplateLayer, type TemplateRelationship, type TemplateRole, type TemplateStructure, type TemplateVersion, type TemplateZone } from '@frameflow/shared';
import { idWords } from '../interactionTerms.js';
import { RunError, type RunRecord } from '../layerizeExperiment.js';
import { templateEditPrompt, templatePlanPrompt, templatePlanStrategy } from './compile.js';

export class TemplateCaptureError extends RunError { constructor(message: string) { super('TEMPLATE_CAPTURE_FAILED', message); this.name = 'TemplateCaptureError'; } }

/** Roles a creative of the template is expected to have (its quality check after a reuse). */
const REQUIRED_ROLES: readonly TemplateRole[] = ['primary_subject', 'secondary_subject', 'held_object', 'main_product', 'headline', 'cta'];
/** A coarse zone from a planner's region words ("center-left, 20–60% across…"); undefined when it gives none. */
export function zoneOf(region: string): TemplateZone | undefined {
  const r = region.toLowerCase();
  if (/\b(?:full|entire|whole) (?:canvas|image|frame|background)\b|\bedge to edge\b|\bfills? the (?:canvas|image|frame)\b/.test(r)) return 'full-canvas';
  const v = /\b(?:top|upper)\b/.test(r) ? 'top' : /\b(?:bottom|lower)\b/.test(r) ? 'bottom' : 'middle', h = /\bleft\b/.test(r) ? 'left' : /\bright\b/.test(r) ? 'right' : 'center';
  if (v === 'middle' && h === 'center') return /\b(?:cent(?:er|re)d?|middle)\b/.test(r) ? 'center' : undefined;
  const zone = v === 'middle' ? `middle-${h}` : `${v}-${h}`;
  return (TEMPLATE_ZONES as readonly string[]).includes(zone) ? zone as TemplateZone : undefined;
}
/** A structural name from the roles alone, for when the planner's name is not content-agnostic. */
export function structuralName(layers: TemplateLayer[]): string {
  const has = (role: TemplateRole) => layers.some(l => l.role === role);
  if (has('primary_subject') && has('held_object')) return 'Subject Holding Product';
  if (has('primary_subject') && has('secondary_subject')) return 'Group of Subjects';
  if (has('primary_subject') && has('main_product')) return 'Subject with Product';
  if (has('primary_subject')) return 'Subject Portrait';
  if (has('main_product')) return ['Product', has('headline') ? 'Headline' : '', has('cta') ? 'CTA' : '', 'Background'].filter(Boolean).join(' + ');
  if (has('headline')) return 'Text-led Creative';
  return 'Custom Layout';
}

/** The version a successful creating run teaches. Throws TemplateCaptureError when the run has nothing reusable. */
export function captureTemplateVersion(run: RunRecord, input: { templateId: string; executionId: string; createdAt?: string }): TemplateVersion {
  const planner = run.planner, semantic = planner?.semantic_analysis, capture = planner?.capture;
  if (run.stage !== 'done' || !planner || !semantic || !capture) throw new TemplateCaptureError('The creating run has no planner structure to learn a template from.');
  const coverage = run.refinement?.planCoverage, background = run.refinement?.background;
  if (!coverage?.complete || background?.quality !== 'usable' || background.contaminated || run.refinement?.state === 'failed') {
    throw new TemplateCaptureError('The result has unverified foreground coverage or background quality. Review the layers before creating a reusable template.');
  }
  // Everything this image showed, in the planner's own words: none of it may reach the template.
  const content = contentWords([semantic.scene_summary, ...semantic.elements.flatMap(e => [e.description, e.type, idWords(e.id)]), planner.prompt]);
  const merged = new Set((planner.semantic_protection?.merged ?? []).map(m => m.id));
  const elements = [...semantic.elements].sort((a, b) => a.z_order - b.z_order || a.id.localeCompare(b.id));
  if (elements.some(e => !isTemplateRole(capture.roles[e.id]))) throw new TemplateCaptureError('The planner did not give every element a structural role.');
  // Role-based ids: the element ids name content ("baby_girl"), so they are replaced.
  const seen = new Map<TemplateRole, number>(), idOf = new Map<string, string>();
  for (const e of elements) { const role = capture.roles[e.id], n = (seen.get(role) ?? 0) + 1; seen.set(role, n); idOf.set(e.id, n === 1 ? role : `${role}_${n}`); }
  const layers: TemplateLayer[] = elements.map((e, order) => {
    const role = capture.roles[e.id], independent = e.editable_independently && !merged.has(e.id), parent = e.attachment.relation !== 'none' ? idOf.get(e.attachment.parent_id) : undefined, zone = zoneOf(e.approximate_region);
    return { id: idOf.get(e.id)!, role, order, independent, required: independent && REQUIRED_ROLES.includes(role),
      ...(parent && e.attachment.relation !== 'none' ? { attachment: { relation: e.attachment.relation, parent, keepWithParent: e.attachment.keep_with_parent || !independent, separationRisk: e.attachment.separation_risk } } : {}),
      ...(e.occlusion.occluded_by.length || e.occlusion.requires_reconstruction ? { occlusion: { occludedBy: e.occlusion.occluded_by.map(id => idOf.get(id)).filter((id): id is string => !!id), requiresReconstruction: e.occlusion.requires_reconstruction } } : {}),
      ...(zone ? { zone } : {}) };
  });
  const independent = layers.filter(l => l.independent);
  if (!independent.some(l => !['background', 'backdrop'].includes(l.role))) throw new TemplateCaptureError('The creative has no foreground element to make a template of.');
  const relationships: TemplateRelationship[] = [...new Map(semantic.relationships.flatMap(r => {
    const source = idOf.get(r.source), target = idOf.get(r.target);
    return source && target && source !== target ? [[`${source}|${target}`, { source, relation: templateRelation(r.relationship), target }] as const] : [];
  })).values()];
  const structure: TemplateStructure = canonicalStructure({ layers, relationships });
  // The planner's composition name and sentence, unless they carry this image's content.
  const plain = (text: string, limit: number) => { const clean = text.replace(/\s+/g, ' ').trim(); return clean && clean.length <= limit && !leakedContent(clean, content).length && !/[{}<>]/.test(clean) ? clean : undefined; };
  const name = plain(capture.name, 60) ?? structuralName(layers);
  const description = plain(capture.description, 240) ?? `A composition of ${independent.map(l => TEMPLATE_ROLE_LABELS[l.role].toLowerCase()).join(', ')}.`;
  const editorLayers = run.editorLayerFiles?.length ?? run.outputLayers?.length ?? independent.length;
  const version: TemplateVersion = {
    templateId: input.templateId, version: 1, createdAt: input.createdAt ?? new Date().toISOString(), name, description, structure,
    plan: { strategy: templatePlanStrategy(structure), prompt: templatePlanPrompt(structure, true), recommendedLayers: structure.layers.filter(l => l.independent).length, occlusionWording: true },
    generationPrompt: { text: templateEditPrompt(structure) },
    decomposition: { refinement: true, expectedEditorLayers: { min: Math.max(1, layers.filter(l => l.required).length), max: Math.max(independent.length, editorLayers) + 2 } },
    source: { executionId: input.executionId, runId: run.id, plannerModel: planner.model },
  };
  // A last check of every text that did not come from the role vocabulary: no content word of the source image in it.
  // (The plan, strategy and edit prompt are built only from roles, zones and relations: enums, never image words.)
  const leaked = leakedContent([name, description, ...layers.map(l => l.id), ...relationships.map(r => `${r.source} ${r.target}`)].join(' '), content);
  if (leaked.length) throw new TemplateCaptureError(`The template would keep this image's content (${leaked.slice(0, 5).join(', ')}); it was not saved.`);
  return version;
}
