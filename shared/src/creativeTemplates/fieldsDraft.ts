/**
 * The template's own fields as a smart-edit draft, so the normal Generate of the wizard runs the same change-planning
 * engine as the image's item cards: one engine, two ways in.
 *
 * Each filled field becomes an explicit edit of the detected item it maps to. The mapping comes from the image's
 * analysis (mapSceneToSlots: by the field's role and position, never by a field name or a product category), so it works
 * for any template and any content. Fields left empty stay inherited: what else must change is the engine's decision (the
 * scene's own relations, the brands it shows, the resolver for anything unfamiliar), and what is ambiguous is asked. A
 * filled field that nothing in the image matches is reported, never dropped.
 *
 * Creatives here are text-free: the engine never writes text. A filled text field is reported in `textFields`, and the
 * wizard keeps the template's own text behaviour for that request instead (nothing typed is lost).
 */
import { allowedActions, type ObjectEdit, type SceneDraft } from './changePlan.js';
import type { TemplateEditOptions, TemplateSlot } from './editPlan.js';
import { mainObjects, type SceneDescription, type SceneSlotMapping } from './scene.js';

export interface FieldsDraftInput {
  /** The fields as typed (field id → value); empty values mean "inherit". */
  values: Record<string, string>;
  /** The main product field's options: replace (a different product) or details (the same product, changed); its brand; keep the other products. */
  mainProduct?: TemplateEditOptions['mainProduct'];
  /** A product photo of the new main product is attached. */
  productPhoto?: boolean;
  /** The user's answers to the engine's questions (item id → edit): kept for items no field changes. */
  answers?: SceneDraft['edits'];
}
export interface FieldsDraft {
  draft: SceneDraft;
  /** Filled fields that could not be applied, said plainly (nothing is silently dropped). */
  problems: string[];
  /** Which field each edited item came from (item id → field id), to lead a question back to its field. */
  fieldOf: Record<string, string>;
  /** Filled text fields (the engine writes no text; the template's own prompt applies them as typed). */
  textFields: string[];
}

export function draftFromTemplateFields(scene: SceneDescription, mapping: SceneSlotMapping | undefined, slots: TemplateSlot[], input: FieldsDraftInput): FieldsDraft {
  const itemOf = Object.fromEntries(Object.entries(mapping?.slots ?? {}).map(([itemId, slotId]) => [slotId, itemId])) as Record<string, string>;
  const mapped = new Set(Object.values(itemOf));
  const edits: Record<string, ObjectEdit> = {}, problems: string[] = [], fieldOf: Record<string, string> = {}, textFields: string[] = [];
  const main = slots.find(s => s.role === 'main_product' && s.group === 'product'), mode = input.mainProduct?.mode ?? 'replace';
  // A field nothing was mapped to: the one obvious item of its kind, when there is exactly one.
  const fallback = (slot: TemplateSlot): string | undefined => {
    if (slot === main) { const candidates = mainObjects(scene).filter(o => !mapped.has(o.id)); return candidates.length === 1 ? candidates[0].id : undefined; }
    if (slot.role === 'background') { const bg = scene.objects.filter(o => !o.ignored && o.kind === 'scenery' && o.importance === 'background' && !mapped.has(o.id)); return bg.length === 1 ? bg[0].id : undefined; }
    return undefined;
  };
  for (const slot of slots) {
    const raw = input.values[slot.id]?.trim();
    if (!raw) continue;
    if (slot.kind === 'text') { textFields.push(slot.id); continue; }
    const target = itemOf[slot.id] ?? fallback(slot);
    if (!target) {
      problems.push(`${slot.label}: nothing in your image matches this field, so it was not changed. Choose the item under "Edit what's in the image".`);
      continue;
    }
    const allowed = allowedActions(scene, target);
    let edit: ObjectEdit | undefined;
    if (slot.kind === 'style') edit = allowed.includes('modify') ? { action: 'modify', value: raw } : undefined;
    else if (slot === main && mode === 'details') edit = allowed.includes('modify') ? { action: 'modify', value: raw } : undefined;
    else edit = allowed.includes('replace') ? { action: 'replace', value: raw, ...(slot === main && input.mainProduct?.brand?.trim() ? { brand: input.mainProduct.brand.trim() } : {}) } : undefined;
    if (!edit) { problems.push(`${slot.label}: the matching item in your image cannot be changed that way.`); continue; }
    edits[target] = edit; fieldOf[target] = slot.id;
  }
  // "Keep the original supporting products": each one the user did not change is explicitly kept.
  if (input.mainProduct?.keepSupporting) for (const slot of slots.filter(s => s.role === 'supporting_product')) { const id = itemOf[slot.id]; if (id && !edits[id]) { edits[id] = { action: 'keep' }; fieldOf[id] = slot.id; } }
  // The user's answers to questions apply to what no field changes (a field is the user's own, more direct word).
  for (const [id, answer] of Object.entries(input.answers ?? {})) if (!fieldOf[id] && allowedActions(scene, id).includes(answer.action)) edits[id] = answer;
  const mainTarget = main ? Object.keys(fieldOf).find(id => fieldOf[id] === main.id) : undefined;
  const referenceFor = input.productPhoto && mainTarget && edits[mainTarget]?.action === 'replace' ? mainTarget : undefined;
  return { draft: { edits, corrections: {}, ...(referenceFor ? { referenceFor } : {}) }, problems, fieldOf, textFields };
}
