/**
 * A template version, compiled locally into what an execution needs: the semantic plan its decomposition run uses
 * instead of a planner call, and the role-based texts (the layer-model instruction, the image-edit prompt) a version is
 * saved with. Everything here is built from roles (TEMPLATE_ROLE_DESCRIPTIONS), never from one image's content, so the
 * same plan fits every creative of the template. No model call.
 */
import { EDIT_INSTRUCTION_SLOT, TEMPLATE_ROLE_DESCRIPTIONS, TEMPLATE_ROLE_LABELS, type TemplateLayer, type TemplateStructure, type TemplateVersion } from '@frameflow/shared';
import { MAX_LAYERIZE_PROMPT, validatePlan } from '../layerizePlanner.js';
import type { PromptSource } from '../layerizeExperiment.js';
import { semanticPlan, type SemanticAnalysis } from '../semanticPlanner.js';

const ZONE_WORDS: Record<NonNullable<TemplateLayer['zone']>, string> = { 'top-left': 'at the top left', 'top-center': 'at the top', 'top-right': 'at the top right', 'middle-left': 'on the left',
  center: 'in the center', 'middle-right': 'on the right', 'bottom-left': 'at the bottom left', 'bottom-center': 'at the bottom', 'bottom-right': 'at the bottom right', 'full-canvas': 'across the whole canvas' };
const backToFront = (layers: TemplateLayer[]) => [...layers].sort((a, b) => a.order - b.order);
const label = (layer: TemplateLayer) => TEMPLATE_ROLE_LABELS[layer.role].toLowerCase();
const joinAnd = (parts: string[]) => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
/**
 * Where a layer continues behind the layers in front of it, from its saved occlusion, in role words ("including where it
 * is behind the supporting product at the top"): a layer whose hidden part is rebuilt is asked for whole, so a part of it
 * that shows only between the layers in front (an open lid behind an earbud) is not left out of every layer.
 */
function behindClause(layer: TemplateLayer, structure: TemplateStructure): string {
  if (layer.role === 'background' || !layer.occlusion?.requiresReconstruction) return '';
  const front = layer.occlusion.occludedBy.map(id => structure.layers.find(l => l.id === id)).filter((l): l is TemplateLayer => !!l && l.independent && l.order > layer.order);
  const byRole = new Map<string, TemplateLayer[]>();
  for (const l of front) byRole.set(label(l), [...(byRole.get(label(l)) ?? []), l]);
  const names = [...byRole].map(([name, same]) => same.length > 1 ? `the ${name} layers` : `the ${name}${same[0].zone ? ` ${ZONE_WORDS[same[0].zone]}` : ''}`);
  return names.length ? `, including where it is behind ${joinAnd(names)}` : '';
}
/** What one layer of the template contains, in role words: what it is for, where, what it continues behind, and what stays with it. */
function layerSentence(layer: TemplateLayer, structure: TemplateStructure, occlusion = false): string {
  const kept = structure.layers.filter(l => !l.independent && l.attachment?.parent === layer.id).map(l => `the ${label(l)}`);
  return `${TEMPLATE_ROLE_DESCRIPTIONS[layer.role]}${layer.zone ? ` ${ZONE_WORDS[layer.zone]}` : ''}${occlusion ? behindClause(layer, structure) : ''}${kept.length ? `, together with ${kept.join(' and ')} in the same layer` : ''}`;
}
/** The layer model's instruction for every creative of this structure (back to front, within the prompt budget). */
export function templatePlanPrompt(structure: TemplateStructure, occlusion = false): string {
  const layers = backToFront(structure.layers).filter(l => l.independent);
  const head = `Create ${layers.length} layer${layers.length === 1 ? '' : 's'} back-to-front: `, tail = '. Preserve exact positions, colors, edges and visible text; do not invent content.';
  const prompt = `${head}${layers.map((l, i) => `(${i + 1}) ${layerSentence(l, structure, occlusion)}`).join('; ')}${tail}`;
  return prompt.length <= MAX_LAYERIZE_PROMPT - 200 ? prompt : `${head}${layers.map((l, i) => `(${i + 1}) ${TEMPLATE_ROLE_DESCRIPTIONS[l.role]}`).join('; ')}${tail}`;
}
/** How the structure is split, in role words. */
export function templatePlanStrategy(structure: TemplateStructure): string {
  const layers = backToFront(structure.layers), independent = layers.filter(l => l.independent), kept = layers.filter(l => !l.independent && l.attachment);
  return `${independent.length} editable layer${independent.length === 1 ? '' : 's'}, back to front: ${independent.map(label).join(', ')}.${kept.length ? ` Kept with their parent: ${kept.map(l => `the ${label(l)} with the ${label(structure.layers.find(p => p.id === l.attachment!.parent) ?? l)}`).join('; ')}.` : ''}`;
}
/** The composition a template keeps, as one role-based clause ("the primary subject in the center, holding the held object, in front of the backdrop"). */
export function compositionClause(structure: TemplateStructure): string {
  const layers = backToFront(structure.layers), front = layers.filter(l => l.independent && !['background', 'backdrop', 'decoration', 'effect'].includes(l.role)).reverse();
  const held = (l: TemplateLayer) => structure.layers.filter(h => h.role === 'held_object' && (h.attachment?.parent === l.id || structure.relationships.some(r => r.source === l.id && r.target === h.id && r.relation === 'holds')));
  const parts = front.filter(l => !(l.role === 'held_object' && front.some(p => held(p).includes(l)))).map(l => `the ${label(l)}${l.zone ? ` ${ZONE_WORDS[l.zone]}` : ''}${held(l).length ? `, holding the ${held(l).map(label).join(' and ')}` : ''}`);
  const behind = layers.filter(l => l.independent && ['backdrop', 'background'].includes(l.role)).reverse().map(l => `the ${label(l)}`);
  return [parts.join(', '), behind.length ? `in front of ${behind.join(' and ')}` : ''].filter(Boolean).join(', ') || 'its elements as they are';
}
/** The reusable image-edit prompt: the user's change slot, and the composition every edit keeps. */
export function templateEditPrompt(structure: TemplateStructure): string {
  return `Edit the attached creative. Make only this change: ${EDIT_INSTRUCTION_SLOT}. Keep its composition: ${compositionClause(structure)}. Keep everything the change does not name exactly as it is: every element's position, size, pose and stacking, the lighting, colors and style, and all visible text. Do not add or remove elements, and do not add text or logos.`;
}

/** The semantic analysis a template version stands for: what the planner would have said, in role words. */
export function templateSemanticAnalysis(version: TemplateVersion): SemanticAnalysis {
  const layers = backToFront(version.structure.layers);
  return {
    image_type: 'creative template', scene_summary: version.description,
    elements: layers.map(l => ({ id: l.id, type: l.role, description: layerSentence(l, version.structure, version.plan.occlusionWording), editable_independently: l.independent, approximate_region: l.zone ? ZONE_WORDS[l.zone] : 'as in the image',
      z_order: l.order, confidence: 'high' as const,
      occlusion: { is_occluded: !!l.occlusion?.occludedBy.length, occluded_by: l.occlusion?.occludedBy ?? [], requires_reconstruction: l.occlusion?.requiresReconstruction ?? false },
      attachment: l.attachment ? { relation: l.attachment.relation, parent_id: l.attachment.parent, separation_risk: l.attachment.separationRisk, keep_with_parent: l.attachment.keepWithParent }
        : { relation: 'none' as const, parent_id: '', separation_risk: 'low' as const, keep_with_parent: false } })),
    relationships: version.structure.relationships.map(r => ({ source: r.source, relationship: r.relation, target: r.target })),
    ambiguities: [], recommended_layer_count: layers.filter(l => l.independent).length, decomposition_strategy: version.plan.strategy, downstream_decomposition_prompt: version.plan.prompt,
  };
}

/**
 * A simpler grouping of a template's plan, for an extraction the provider rejected: the backdrop, decorations and effects
 * become part of one scene plate, and supporting products go with the main product — fewer, larger, meaningful layers.
 * Built from roles, locally; no planner call.
 */
export function simpleTemplateVersion(version: TemplateVersion): TemplateVersion {
  const layers = version.structure.layers, background = layers.find(l => l.role === 'background'), main = layers.find(l => l.role === 'main_product' && l.independent);
  const fold = (l: TemplateLayer, parent?: TemplateLayer): TemplateLayer => parent && parent.id !== l.id && l.independent
    ? { ...l, independent: false, required: false, attachment: { relation: 'part_of_object', parent: parent.id, keepWithParent: true, separationRisk: 'low' } } : l;
  const simple = layers.map(l => ['backdrop', 'decoration', 'effect'].includes(l.role) ? fold(l, background) : l.role === 'supporting_product' ? fold(l, main) : l);
  return { ...version, structure: { ...version.structure, layers: simple } };
}
export const compileSimpleTemplatePlan = (version: TemplateVersion, compiledAt?: string) => compileTemplatePlan(simpleTemplateVersion(version), compiledAt);

/** A run's prompt source from a template version: its saved plan, protected and validated as a planner answer would be. */
export function compileTemplatePlan(version: TemplateVersion, compiledAt = new Date().toISOString()): Extract<PromptSource, { mode: 'template-plan' }> {
  const semantic = semanticPlan(templateSemanticAnalysis(version));
  return { mode: 'template-plan', templateId: version.templateId, templateName: version.name, version: version.version, compiledAt, ...semantic, ...validatePlan(semantic) };
}
