/**
 * Blueprints: from a structural analysis (or a seed) to one reusable version of a family, and from a version plus one
 * creative's slot values to its generation prompt and its decomposition plan. Everything here is local and
 * deterministic: compiling a known family costs no model call.
 */
import { compileTemplate, sanitizeSlotValue, templateProblems } from './promptTemplate.js';
import { compositionPattern, layoutSentence, normalizeSignature, signatureKey, structuralName, zoneWords } from './signature.js';
import type { BlueprintSlot, CurationPolicy, DecompositionPlanTemplate, InstanceContent, PlanElementTemplate, SlotKind, StructuralElement, StructuralRole, StructuralSignature, StructureAnalysis, TemplateBlueprint } from './types.js';

/** Bump when the compiled wording changes: cache keys include it, so no stale compiled prompt is ever served. */
export const BLUEPRINT_PROMPT_VERSION = 1;
export const BLUEPRINT_RATIOS = ['1:1', '4:5', '16:9'] as const;
/** The editable generation prompt budget of image templates (IMAGE_TEMPLATE_LIMITS.prompt). */
export const BLUEPRINT_PROMPT_LIMIT = 2000;
/** The decomposition prompt budget (semanticPlanner PROMPT_BUDGET). */
export const PLAN_PROMPT_LIMIT = 1750;

type SlotSpec = { kind: SlotKind; label: string; placeholder: string; native: boolean; maxLength: number };
const SLOT_SPECS: Partial<Record<StructuralRole, SlotSpec>> = {
  product: { kind: 'product', label: 'Product', placeholder: 'e.g. wireless earbuds in matte white', native: false, maxLength: 140 },
  person: { kind: 'person', label: 'Person', placeholder: 'e.g. a smiling young woman in a denim jacket', native: false, maxLength: 140 },
  headline: { kind: 'text', label: 'Headline', placeholder: 'e.g. Festive Sale', native: true, maxLength: 80 },
  subheadline: { kind: 'text', label: 'Subheadline', placeholder: 'e.g. New arrivals every week', native: true, maxLength: 100 },
  body: { kind: 'text', label: 'Body text', placeholder: 'e.g. Free delivery on all orders', native: true, maxLength: 140 },
  price: { kind: 'offer', label: 'Price', placeholder: 'e.g. ₹2,999', native: true, maxLength: 40 },
  offer: { kind: 'offer', label: 'Offer', placeholder: 'e.g. Up to 50% off', native: true, maxLength: 60 },
  cta: { kind: 'cta', label: 'Button text', placeholder: 'e.g. Shop Now', native: true, maxLength: 30 },
  badge: { kind: 'offer', label: 'Badge', placeholder: 'e.g. 40% OFF', native: true, maxLength: 30 },
  logo: { kind: 'logo', label: 'Logo', placeholder: 'e.g. keep the brand logo', native: true, maxLength: 60 },
  frame: { kind: 'decoration', label: 'Frame style', placeholder: 'e.g. gold arch border', native: false, maxLength: 100 },
  object: { kind: 'object', label: 'Prop', placeholder: 'e.g. a small gift box', native: false, maxLength: 100 },
};
const BASE_ID: Partial<Record<StructuralRole, string>> = { person: 'subject' };
/** Roles a creative of the family must show (matching requires them). */
const REQUIRED_ROLES: readonly StructuralRole[] = ['product', 'person', 'headline', 'cta', 'frame'];
/** Words for a role inside prompts. */
const ROLE_WORDS: Record<StructuralRole, string> = {
  background: 'background', product: 'product', person: 'person', headline: 'headline', subheadline: 'subheadline', body: 'body text', price: 'price', offer: 'offer text',
  cta: 'call-to-action button', badge: 'offer badge', logo: 'logo', frame: 'decorative frame', panel: 'panel', decoration: 'decorations', object: 'prop',
};
/** Semantic-planner types for the plan: words the protection and coverage code already reads (text, person, product). */
const PLAN_TYPES: Record<StructuralRole, string> = {
  background: 'background', product: 'product', person: 'person', headline: 'headline text', subheadline: 'subheadline text', body: 'body text', price: 'price text', offer: 'offer text',
  cta: 'call-to-action button', badge: 'offer badge', logo: 'logo', frame: 'decorative frame', panel: 'panel graphic', decoration: 'decorative graphics', object: 'prop object',
};

const position = (e: StructuralElement) => zoneWords(e.box);
/** Slots from the structure: one per meaningful element (numbered when a role repeats), one for decorations, one for the background. */
export function deriveSlots(signature: StructuralSignature): BlueprintSlot[] {
  const s = normalizeSignature(signature), slots: BlueprintSlot[] = [];
  const byRole = new Map<StructuralRole, StructuralElement[]>();
  for (const e of s.elements) byRole.set(e.role, [...(byRole.get(e.role) ?? []), e]);
  for (const [role, elements] of byRole) {
    const spec = SLOT_SPECS[role];
    if (!spec) continue;
    const ordered = [...elements].sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
    ordered.forEach((e, i) => {
      const id = `${BASE_ID[role] ?? role}${ordered.length > 1 ? `-${i + 1}` : ''}`;
      const relation = s.relations.find(r => r.from === e.id || r.to === e.id);
      slots.push({ id, kind: spec.kind, elementId: e.id, role, label: ordered.length > 1 ? `${spec.label} ${i + 1} (${position(e)})` : spec.label, placeholder: spec.placeholder,
        required: REQUIRED_ROLES.includes(role), editable: true, nativeEditable: spec.native, maxLength: spec.maxLength, expectedRegion: { ...e.box },
        ...(relation ? { parentRelationship: { type: relation.type, target: relation.from === e.id ? relation.to : relation.from } } : {}), defaultValue: '' });
    });
  }
  if (byRole.has('decoration')) slots.push({ id: 'decorations', kind: 'decoration', role: 'decoration', label: 'Decorations', placeholder: 'e.g. marigold garlands and diyas', required: false, editable: true, nativeEditable: false, maxLength: 100, defaultValue: '' });
  slots.push({ id: 'background', kind: 'background', role: 'background', label: 'Background', placeholder: 'e.g. deep red gradient with soft glow', required: false, editable: true, nativeEditable: false, maxLength: 120, defaultValue: '' });
  const order: SlotKind[] = ['product', 'person', 'background', 'text', 'offer', 'cta', 'logo', 'decoration', 'object'];
  return slots.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

const quote = (id: string) => `"{{${id}}}"`;
/** One generation sentence per slot: change it when a value is given, keep it exactly when not. */
function generationSentence(slot: BlueprintSlot, element?: StructuralElement): string {
  const where = element ? ` (${position(element)})` : '', thing = `the ${ROLE_WORDS[slot.role]}${where}`;
  switch (slot.kind) {
    case 'product': case 'person': case 'object':
      return `{{#${slot.id}}}Replace ${thing} with {{${slot.id}}}, in the same place, at the same scale and angle, lit like the original.{{/${slot.id}}}{{^${slot.id}}}Keep ${thing} exactly as it is.{{/${slot.id}}}`;
    case 'background':
      return `{{#background}}Change the background to {{background}}, keeping the same composition and depth.{{/background}}{{^background}}Keep the background style.{{/background}}`;
    case 'decoration':
      return `{{#${slot.id}}}Change ${slot.role === 'frame' ? thing : 'the decorations'} to {{${slot.id}}}, in the same places.{{/${slot.id}}}{{^${slot.id}}}Keep ${slot.role === 'frame' ? thing : 'the decorations'} as they are.{{/${slot.id}}}`;
    case 'logo':
      return `{{#${slot.id}}}The logo${where}: {{${slot.id}}}.{{/${slot.id}}}{{^${slot.id}}}Keep the logo${where} exactly.{{/${slot.id}}}`;
    default:
      return `{{#${slot.id}}}${thing[0].toUpperCase()}${thing.slice(1)} reads exactly ${quote(slot.id)}, in the same place and type style.{{/${slot.id}}}{{^${slot.id}}}Keep the text of ${thing} exactly.{{/${slot.id}}}`;
  }
}
/** The family's generation prompt template: its fixed layout, then one sentence per slot. */
export function buildGenerationPromptTemplate(signature: StructuralSignature, slots: BlueprintSlot[]): string {
  const s = normalizeSignature(signature);
  const sentences = slots.map(slot => generationSentence(slot, s.elements.find(e => e.id === slot.elementId)));
  return [`Recreate this advertising creative with the same layout: ${layoutSentence(s)}.`, ...sentences,
    'Keep every other element, its position, size and stacking. Do not add, remove or move elements, and do not invent extra text or logos.'].join(' ');
}

/** The decomposition plan template: the editor layers this structure should become, back to front, with slot placeholders. */
export function buildDecompositionPlanTemplate(signature: StructuralSignature, slots: BlueprintSlot[]): DecompositionPlanTemplate {
  const s = normalizeSignature(signature), elements: PlanElementTemplate[] = [];
  const slotOf = (e: StructuralElement) => slots.find(slot => slot.elementId === e.id);
  const background = !['flat', 'gradient'].includes(s.background) && s.background !== 'unknown' ? 'scene-plate' as const : 'clean-plate' as const;
  elements.push({ id: 'background', type: 'background', role: 'background', slotId: 'background', required: true, z: 0, region: 'full canvas',
    descriptionTemplate: `{{#background}}the {{background}} background{{/background}}{{^background}}the ${background === 'scene-plate' ? 'whole background scene as one plate' : 'clean background'}{{/background}} filling the canvas, with nothing in front of it` });
  const decorations = s.elements.filter(e => e.role === 'decoration');
  if (decorations.length) elements.push({ id: 'decorations', type: 'decorative graphics', role: 'decoration', slotId: 'decorations', required: false, z: Math.min(...decorations.map(e => e.z)), region: 'around the layout',
    descriptionTemplate: 'the small decorative graphics{{#decorations}} ({{decorations}}){{/decorations}} grouped as one layer' });
  for (const e of s.elements.filter(x => x.role !== 'decoration')) {
    const slot = slotOf(e), id = `${slot?.id ?? e.id}`.replace(/-/g, '_');
    const named = slot ? `{{#${slot.id}}}the {{${slot.id}}}{{/${slot.id}}}{{^${slot.id}}}the ${ROLE_WORDS[e.role] === 'product' ? 'main product' : ROLE_WORDS[e.role]}{{/${slot.id}}}` : `the ${ROLE_WORDS[e.role]}`;
    const text = slot && ['text', 'cta', 'offer'].includes(slot.kind);
    const description = e.role === 'person' ? `${named} in the ${position(e)}, whole, with hands, worn jewelry and accessories`
      : text ? `the ${ROLE_WORDS[e.role]}{{#${slot!.id}}} ${quote(slot!.id)}{{/${slot!.id}}} in the ${position(e)}${e.role === 'cta' || e.role === 'badge' ? ', shape and label together' : ', with its own outline and effects'}`
        : `${named} in the ${position(e)}`;
    const holder = s.relations.find(r => r.to === e.id && (r.type === 'holds' || r.type === 'wears'));
    const worn = s.relations.find(r => r.from === e.id && r.type === 'attached_to');
    const parent = holder ? s.elements.find(x => x.id === holder.from) : worn ? s.elements.find(x => x.id === worn.to) : undefined;
    const parentId = parent ? (slotOf(parent)?.id ?? parent.id).replace(/-/g, '_') : undefined;
    elements.push({ id, type: PLAN_TYPES[e.role], role: e.role, ...(slot ? { slotId: slot.id } : {}), required: REQUIRED_ROLES.includes(e.role), z: e.z, region: `${position(e)}, about ${Math.round(e.box.x * 100)}–${Math.round((e.box.x + e.box.width) * 100)}% across and ${Math.round(e.box.y * 100)}–${Math.round((e.box.y + e.box.height) * 100)}% down`,
      descriptionTemplate: description,
      // A held or worn item stays with its person unless the split is known to be clean (protected interactions).
      ...(parentId ? { attachment: { relation: holder?.type === 'wears' ? 'worn_by_human' as const : holder ? 'held_in_hand' as const : 'attached_to_human' as const, parent: parentId, separationRisk: 'medium' as const, keepWithParent: true } } : {}) });
  }
  return { version: 1, imageType: 'advertising creative', elements: elements.sort((a, b) => a.z - b.z), backgroundPolicy: background,
    exclusions: 'Do not create separate layers for shadows, reflections, glows, outlines, sparkles, confetti or small decorative pieces; each stays with the element it belongs to. Do not output a second background.' };
}

export function curationPolicyFor(plan: DecompositionPlanTemplate): CurationPolicy {
  const independent = plan.elements.filter(e => !e.attachment).length, required = plan.elements.filter(e => e.required && !e.attachment).length;
  return { expectedEditorLayers: { min: Math.max(1, required), max: independent + 2 }, maxRawLayers: independent + 3 };
}

/** A structural name for display: the planner's suggestion unless it names this image's content, else the pattern's. */
export function safeLayoutName(suggested: string, signature: StructuralSignature, instance?: InstanceContent): string {
  const name = sanitizeSlotValue(suggested, 60).replace(/[^\p{L}\p{N} &+\-/]/gu, '').trim();
  const contentWords = new Set(Object.values(instance?.elements ?? {}).flatMap(c => `${c.label} ${c.text}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)).concat((instance?.background ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(w => w.length >= 4));
  const leaks = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(w => contentWords.has(w));
  return name && !leaks && name.split(/\s+/).length <= 6 ? name : structuralName(signature);
}

/** A new blueprint version from a structural analysis. Instance content is used only to check the name, never stored. */
export function blueprintFromAnalysis(analysis: StructureAnalysis, input: { familyId: string; version?: number; name?: string; origin: string; now?: string }): TemplateBlueprint {
  const signature = normalizeSignature(analysis.signature), slots = deriveSlots(signature);
  const plan = buildDecompositionPlanTemplate(signature, slots);
  const blueprint: TemplateBlueprint = {
    familyId: input.familyId, version: input.version ?? 1, name: input.name ?? safeLayoutName(analysis.layoutName, signature, analysis.instance),
    signatureKey: signatureKey(signature), pattern: compositionPattern(signature), signature, slots,
    generationPromptTemplate: buildGenerationPromptTemplate(signature, slots), decompositionPlanTemplate: plan,
    expectedLayerRoles: [...new Set(plan.elements.filter(e => !e.attachment).map(e => e.role))],
    groupingRules: [
      'Text keeps its own outline, shadow and glow.', 'Badges and buttons keep their shape and label together.', 'Small decorations are grouped into one layer.',
      ...(signature.relations.some(r => r.type === 'holds' || r.type === 'wears' || r.type === 'attached_to') ? ['Held and worn items stay with their person unless the split is clean.'] : []),
      ...(plan.backgroundPolicy === 'scene-plate' ? ['A photographic scene stays one background plate.'] : []),
    ],
    curationPolicy: curationPolicyFor(plan), decompositionRecipe: analysis.decompositionRecipe, supportedRatios: [...BLUEPRINT_RATIOS],
    promptVersion: BLUEPRINT_PROMPT_VERSION, createdAt: input.now ?? new Date().toISOString(), origin: input.origin,
  };
  const problems = blueprintProblems(blueprint);
  if (problems.length) throw new Error(`Invalid blueprint: ${problems.join(' ')}`);
  return blueprint;
}

/** What makes a blueprint unusable: placeholders that are not slots, prompts over budget, no independent layer. */
export function blueprintProblems(blueprint: TemplateBlueprint): string[] {
  const ids = blueprint.slots.map(s => s.id), problems = [...templateProblems(blueprint.generationPromptTemplate, ids)];
  for (const e of blueprint.decompositionPlanTemplate.elements) problems.push(...templateProblems(e.descriptionTemplate, ids));
  const elementIds = blueprint.decompositionPlanTemplate.elements.map(e => e.id);
  if (new Set(elementIds).size !== elementIds.length) problems.push('Duplicate plan element ids.');
  if (!blueprint.decompositionPlanTemplate.elements.some(e => !e.attachment)) problems.push('The plan has no independent layer.');
  if (!problems.length) {
    const longest = Object.fromEntries(blueprint.slots.map(s => [s.id, 'x'.repeat(s.maxLength)]));
    for (const values of [{}, longest]) {
      const prompt = compileGenerationPrompt(blueprint, values);
      if (prompt.length > BLUEPRINT_PROMPT_LIMIT) problems.push(`The generation prompt can reach ${prompt.length} characters (limit ${BLUEPRINT_PROMPT_LIMIT}).`);
      compileDecompositionPlan(blueprint, values);
    }
  }
  return [...new Set(problems)];
}

/** Only the blueprint's own slots, sanitized and bounded; anything else is dropped. */
export function slotValuesFor(blueprint: Pick<TemplateBlueprint, 'slots'>, values: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of blueprint.slots) { const value = sanitizeSlotValue(values[slot.id], slot.maxLength); if (value) out[slot.id] = value; }
  return out;
}
/** The generation prompt for one creative: the version's template with this creative's values. No model call. */
export function compileGenerationPrompt(blueprint: TemplateBlueprint, values: Record<string, unknown>): string {
  return compileTemplate(blueprint.generationPromptTemplate, slotValuesFor(blueprint, values), blueprint.slots.map(s => s.id));
}

/** The semantic plan the decomposition runner validates and protects (semanticPlanner.ts semanticPlan). */
export interface CompiledSemanticPlan {
  image_type: string; scene_summary: string;
  elements: { id: string; type: string; description: string; editable_independently: boolean; approximate_region: string; z_order: number; confidence: 'high' | 'medium' | 'low';
    occlusion: { is_occluded: boolean; occluded_by: string[]; requires_reconstruction: boolean };
    attachment: { relation: 'none' | 'held_in_hand' | 'worn_by_human' | 'attached_to_human' | 'part_of_object'; parent_id: string; separation_risk: 'low' | 'medium' | 'high'; keep_with_parent: boolean } }[];
  relationships: { source: string; relationship: string; target: string }[];
  ambiguities: string[]; recommended_layer_count: number; decomposition_strategy: string; downstream_decomposition_prompt: string;
}
/**
 * The decomposition plan for one creative: the version's expected layers, described with this creative's values, and
 * the Seedream prompt asking for exactly those layers (fewer billable raw layers than an open-ended plan). No model call.
 */
export function compileDecompositionPlan(blueprint: TemplateBlueprint, values: Record<string, unknown>): { plan: CompiledSemanticPlan; requiredElements: string[] } {
  const v = slotValuesFor(blueprint, values), ids = blueprint.slots.map(s => s.id), template = blueprint.decompositionPlanTemplate;
  const elements = template.elements.map((e, i) => ({
    id: e.id, type: e.type, description: compileTemplate(e.descriptionTemplate, v, ids), editable_independently: !e.attachment, approximate_region: e.region, z_order: i, confidence: 'high' as const,
    occlusion: { is_occluded: false, occluded_by: [], requires_reconstruction: false },
    attachment: e.attachment ? { relation: e.attachment.relation, parent_id: e.attachment.parent, separation_risk: e.attachment.separationRisk, keep_with_parent: e.attachment.keepWithParent }
      : { relation: 'none' as const, parent_id: '', separation_risk: 'low' as const, keep_with_parent: false },
  }));
  const independent = elements.filter(e => e.editable_independently);
  const tail = ` ${template.exclusions} Preserve exact positions, colors, edges and visible text; do not invent content.`;
  const head = `Create ${independent.length} layer${independent.length === 1 ? '' : 's'} back-to-front: `;
  const kept = (id: string) => elements.filter(e => e.attachment.parent_id === id).map(e => e.description);
  const room = Math.max(40, Math.floor((PLAN_PROMPT_LIMIT - head.length - tail.length - independent.length * 8) / Math.max(1, independent.length)));
  const describe = (e: typeof elements[number]) => {
    const full = `${e.description}${kept(e.id).length ? ` together with ${kept(e.id).join(', ')} in the same layer` : ''}`;
    return full.length <= room ? full : `${full.slice(0, room - 1).replace(/[\s,;.]+\S*$/, '')}…`;
  };
  const prompt = `${head}${independent.map((e, i) => `(${i + 1}) ${describe(e)}`).join('; ')}.${tail}`;
  return {
    plan: { image_type: template.imageType, scene_summary: `${blueprint.name} layout`, elements,
      relationships: elements.filter(e => e.attachment.relation !== 'none').map(e => ({ source: e.id, relationship: e.attachment.relation.replace(/_/g, ' '), target: e.attachment.parent_id })),
      ambiguities: [], recommended_layer_count: independent.length, decomposition_strategy: `Reused layout plan ${blueprint.familyId}@v${blueprint.version}`, downstream_decomposition_prompt: prompt },
    requiredElements: template.elements.filter(e => e.required && !e.attachment).map(e => e.id),
  };
}

/**
 * Which changes need a new image. Text, buttons, offers and logos are native: they can be changed as editor layers of
 * the decomposed creative, so changing only those never needs image generation.
 */
export function planSlotChanges(blueprint: Pick<TemplateBlueprint, 'slots'>, values: Record<string, unknown>): { changed: string[]; generative: string[]; native: string[]; needsImage: boolean } {
  const v = slotValuesFor(blueprint, values), changed = Object.keys(v);
  const generative = changed.filter(id => !blueprint.slots.find(s => s.id === id)!.nativeEditable), native = changed.filter(id => !generative.includes(id));
  return { changed, generative, native, needsImage: generative.length > 0 };
}

/** One form field per editable slot, in blueprint order: the dynamic form is rendered from this, for any family. */
export interface SlotField { id: string; label: string; kind: SlotKind; placeholder: string; maxLength: number; native: boolean; current?: string; help: string; multiline: boolean }
export function slotFormModel(blueprint: Pick<TemplateBlueprint, 'slots'>, current: Record<string, string> = {}): SlotField[] {
  return blueprint.slots.filter(slot => slot.editable).map(slot => ({
    id: slot.id, label: slot.label, kind: slot.kind, placeholder: slot.placeholder, maxLength: slot.maxLength, native: slot.nativeEditable,
    ...(current[slot.id] ? { current: sanitizeSlotValue(current[slot.id], 80) } : {}),
    multiline: slot.maxLength > 100,
    help: slot.nativeEditable ? 'Prefer an editor text or logo layer for this change when available. Raster text needs manual replacement.' : 'Changing this generates a new image. Leave empty to keep it from your creative.',
  }));
}

/** Current values of a creative by slot, from what a structural analysis saw in THIS image (never from another image). */
export function instanceSlotValues(blueprint: Pick<TemplateBlueprint, 'slots'>, instance: InstanceContent | undefined, mapping: Record<string, string> = {}): Record<string, string> {
  if (!instance) return {};
  const out: Record<string, string> = {};
  for (const slot of blueprint.slots) {
    if (slot.kind === 'background') { if (instance.background) out[slot.id] = sanitizeSlotValue(instance.background, slot.maxLength); continue; }
    const content = slot.elementId ? instance.elements[mapping[slot.elementId] ?? slot.elementId] : undefined;
    const value = content ? (['text', 'cta', 'offer'].includes(slot.kind) ? content.text || content.label : content.label) : '';
    if (value) out[slot.id] = sanitizeSlotValue(value, slot.maxLength);
  }
  return out;
}
export const blueprintSummary = (b: Pick<TemplateBlueprint, 'signature'>) => layoutSentence(b.signature);
