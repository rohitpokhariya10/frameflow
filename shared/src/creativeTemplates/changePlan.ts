/**
 * Smart edits of an existing creative: the image's own scene (scene.ts) and the user's edits resolve into one structured
 * change plan, and the plan compiles locally into the prompt. The rule throughout:
 *
 *   Empty fields inherit the existing content only while it stays compatible with the requested changes.
 *
 * Every plan entry says where it came from: explicit (the user asked), inherited (left as it is) or inferred (a change
 * the requested one depends on: the old product's brand mark goes with it, a new held object needs a new grip). Keeping
 * and removing are separate actions, never both "an empty field". What cannot be decided safely becomes a conflict with
 * concrete options, and generation waits for the user's choice. Explicit choices are never overwritten.
 *
 * The deterministic rules here run first and always. A resolver model may add inferred changes and conflicts; its
 * proposal is validated here (known ids, allowed operations, no invented prices, offers, dates or specifications) before
 * anything of it is used. New creatives of this workflow are text-free: no text, price, badge or logo is ever added.
 */
import { BRAND_LIMIT, FIELD_LIMIT, type BlueprintCompatibility, type EditChange, type EditOperation, type PromptSegment } from './editPlan.js';
import { GENERATE_UNCHANGED_INSTRUCTION, sanitizeEditInstruction } from './editPrompt.js';
import { TEMPLATE_ROLE_LABELS, type TemplateRole } from './roles.js';
import { brandInWords, namesName, namesWord, PRODUCT_LINES, sameBrand, seedBrandOf, seedNamesOf } from './brands.js';
import { attachedTo, cleanSceneText, holderOf, isForeground, positionPhrase, SCENE_MARK_LABELS, SCENE_PROPERTY_KEYS, SCENE_PROPERTY_LABELS, sceneTarget, type SceneCorrection, type SceneDescription, type SceneMark, type SceneObject, type SceneOverlay, type ScenePropertyKey } from './scene.js';

/**
 * The version of the plan rules and prompt compiler: a resolution made under another one is rebuilt before it is used
 * (plan-rules-2: brands read from the user's words, stale brand marks and text, one sentence per item, no contradictions;
 * plan-rules-3: brands the image itself shows, other copies of a replaced product; plan-rules-4: the old brand's other
 * names on the artwork, its short forms and product lines).
 */
export const PLAN_RULES = 'plan-rules-4';
export const OBJECT_ACTIONS = ['keep', 'modify', 'replace', 'remove'] as const;
export type ObjectAction = typeof OBJECT_ACTIONS[number];
export interface ObjectEdit {
  action: ObjectAction;
  /** modify: the new look (of `property`, when given); replace: what replaces it (optional with a product photo). */
  value?: string;
  property?: ScenePropertyKey;
  /** A product's brand, as typed. A brand alone is a meaningful request, never ignored. */
  brand?: string;
  /** The user confirmed this choice although a rule would change it (keep the old mark anyway). */
  confirmed?: boolean;
}
/** What the user asked, before resolution: per detected item, nothing (inherit) or an explicit action. */
export interface SceneDraft {
  edits: Record<string, ObjectEdit>;
  corrections: Record<string, SceneCorrection>;
  /** The object a product photo shows the replacement for (the photo's bytes travel with the request). */
  referenceFor?: string;
}
export const emptyDraft = (): SceneDraft => ({ edits: {}, corrections: {} });

export type PlanSource = 'explicit' | 'inherited' | 'inferred';
/** adjust: a dependent change of something otherwise kept (a hand's grip around a new object). */
export type PlanOperation = 'keep' | 'modify' | 'replace' | 'remove' | 'adjust';
export interface PlanEntry {
  id: string; targetId: string; targetType: 'object' | 'mark' | 'overlay'; label: string;
  /** The saved template field it fills, where one does. */
  slotId?: string; slotRole?: TemplateRole;
  operation: PlanOperation; property?: string;
  /** The current value as detected, and the requested one. */
  from?: string; to?: string; brand?: string;
  source: PlanSource; reason: string; evidence?: string; confidence?: number;
  /** The replacement is shown by the attached product photo. */
  reference?: boolean;
}
export type DraftEffect = { kind: 'edit'; targetId: string; edit: ObjectEdit } | { kind: 'remove-reference' } | { kind: 'focus'; targetId: string };
export interface ConflictOption { id: string; label: string; effects: DraftEffect[] }
export type ConflictKind = 'product-brand' | 'image-text' | 'accessory' | 'identity-unclear' | 'dependency' | 'uncertain-inference' | 'other';
export interface PlanConflict { id: string; kind: ConflictKind; targetIds: string[]; question: string; options: ConflictOption[]; source: 'rule' | 'resolver' }
export interface ChangePlan {
  entries: PlanEntry[]; conflicts: PlanConflict[]; notes: string[];
  /** unchanged: nothing to do; clear: ready to generate; needs-input: a conflict waits for the user. */
  status: 'unchanged' | 'clear' | 'needs-input';
}
export class DraftError extends Error { constructor(message: string) { super(message); this.name = 'DraftError'; } }

/** Which actions each kind of item allows: a background is restyled, never removed; text and logos are kept or removed, never written. */
export function allowedActions(scene: SceneDescription, id: string): readonly ObjectAction[] {
  const target = sceneTarget(scene, id);
  if (!target) return [];
  if (target.type !== 'object') return ['keep', 'remove'];
  const o = target.item;
  if (o.kind === 'scenery' && o.importance === 'background') return ['keep', 'modify'];
  if (o.kind === 'effect') return ['keep', 'remove'];
  return OBJECT_ACTIONS;
}
const ACTION_PAST: Record<ObjectAction, string> = { keep: 'kept', modify: 'changed', replace: 'replaced', remove: 'removed' };
const clean = (value: unknown, limit: number, what: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit) throw new DraftError(`${what} is plain text of at most ${limit} characters.`);
  return sanitizeEditInstruction(value).replace(/["“”]/g, '\'') || undefined;
};
/** A draft from a request or a stored session, checked against this scene: known items, allowed actions, bounded text. */
export function cleanDraft(scene: SceneDescription, value: unknown, options: { hasReference?: boolean } = {}): SceneDraft {
  const raw = value === undefined ? {} : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DraftError('The draft names detected items and what to do with them.');
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!['edits', 'corrections', 'referenceFor'].includes(key)) throw new DraftError(`The draft has no field "${key}".`);
  const edits: Record<string, ObjectEdit> = {};
  const rawEdits = r.edits ?? {};
  if (!rawEdits || typeof rawEdits !== 'object' || Array.isArray(rawEdits)) throw new DraftError('Edits name detected items.');
  for (const [id, e] of Object.entries(rawEdits as Record<string, unknown>)) {
    if (!sceneTarget(scene, id)) throw new DraftError('An edit names an item the analysis did not detect. Analyze the image again.');
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new DraftError('Each edit is an action with optional details.');
    const edit = e as Record<string, unknown>;
    for (const key of Object.keys(edit)) if (!['action', 'value', 'property', 'brand', 'confirmed'].includes(key)) throw new DraftError(`An edit has no field "${key}".`);
    if (!allowedActions(scene, id).includes(edit.action as ObjectAction)) throw new DraftError(`${sceneTarget(scene, id)!.item.label} can only be ${allowedActions(scene, id).map(a => ACTION_PAST[a]).join(' or ')}.`);
    const action = edit.action as ObjectAction, valueText = clean(edit.value, FIELD_LIMIT, 'A new value'), brand = clean(edit.brand, BRAND_LIMIT, 'A brand');
    if (edit.property !== undefined && !(SCENE_PROPERTY_KEYS as readonly unknown[]).includes(edit.property)) throw new DraftError('Choose one of the listed properties to change.');
    if (edit.confirmed !== undefined && typeof edit.confirmed !== 'boolean') throw new DraftError('confirmed is true or false.');
    const target = sceneTarget(scene, id)!;
    if (brand && (target.type !== 'object' || !['product', 'object', 'furniture'].includes(target.item.kind) || !['modify', 'replace'].includes(action))) throw new DraftError('A brand belongs to a product that is replaced or changed.');
    if ((action === 'keep' || action === 'remove') && (valueText || brand || edit.property)) throw new DraftError(`${action === 'keep' ? 'Keeping' : 'Removing'} ${target.item.label} takes no new value.`);
    const photo = !!options.hasReference && r.referenceFor === id;
    if (action === 'modify' && !valueText && !brand) throw new DraftError(`Describe how ${target.item.label} should change.`);
    if (action === 'replace' && !valueText && !brand && !photo) throw new DraftError(`Describe what replaces ${target.item.label}, or attach a product photo.`);
    edits[id] = { action, ...(valueText ? { value: valueText } : {}), ...(edit.property ? { property: edit.property as ScenePropertyKey } : {}), ...(brand ? { brand } : {}), ...(edit.confirmed ? { confirmed: true } : {}) };
  }
  const corrections = r.corrections === undefined ? {} : r.corrections;
  if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)) throw new DraftError('Corrections name detected objects.');
  const referenceFor = r.referenceFor;
  if (referenceFor !== undefined) {
    const target = typeof referenceFor === 'string' ? sceneTarget(scene, referenceFor) : undefined;
    if (!target || target.type !== 'object' || !isForeground(target.item)) throw new DraftError('A product photo goes with a detected object.');
    if (edits[referenceFor as string]?.action !== 'replace') throw new DraftError(`A product photo shows a replacement: choose Replace for ${target.item.label}.`);
    if (!options.hasReference) throw new DraftError('Attach the product photo, or remove it from the request.');
  } else if (options.hasReference) throw new DraftError('Choose which object the product photo replaces.');
  return { edits, corrections: corrections as Record<string, SceneCorrection>, ...(referenceFor ? { referenceFor: referenceFor as string } : {}) };
}
/** The draft as one stable string: what a persisted resolution is bound to (key order never matters). */
export function canonicalDraft(draft: SceneDraft): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
  return JSON.stringify(sorted({ edits: draft.edits, corrections: draft.corrections, referenceFor: draft.referenceFor }));
}
/** Whether the draft changes anything at all (all-empty keeps the original image's option open). */
export const draftChanges = (draft: SceneDraft) => Object.values(draft.edits).some(e => e.action !== 'keep');

const lower = (text: string) => text.toLocaleLowerCase();
/** "the smartphone on the left" (with an ordinal when two of the same kind share a place). */
export function objectPhrase(scene: SceneDescription, o: SceneObject): string {
  const same = scene.objects.filter(x => lower(x.category) === lower(o.category) && x.zone === o.zone);
  const n = same.indexOf(o) + 1, ordinal = same.length > 1 ? ` (${['first', 'second', 'third', 'fourth', 'fifth'][n - 1] ?? `number ${n}`})` : '';
  return `the ${lower(o.category)}${o.zone === 'full-canvas' ? '' : ` ${positionPhrase(o.zone)}`}${ordinal}`;
}
export function markPhrase(scene: SceneDescription, m: SceneMark): string {
  const owner = m.ownerId ? scene.objects.find(o => o.id === m.ownerId) : undefined;
  return `the ${lower(SCENE_MARK_LABELS[m.kind])}${owner ? ` on ${objectPhrase(scene, owner)}` : ` ${positionPhrase(m.zone)}`}`;
}
/** Overlaid text is named by its place, never quoted: image text is data, not an instruction. */
export const overlayPhrase = (t: SceneOverlay) => `the overlaid text block ${positionPhrase(t.zone)}`;
export function targetPhrase(scene: SceneDescription, id: string): string {
  const t = sceneTarget(scene, id);
  return !t ? 'that element' : t.type === 'object' ? objectPhrase(scene, t.item) : t.type === 'mark' ? markPhrase(scene, t.item) : overlayPhrase(t.item);
}
const typeOf = (scene: SceneDescription, id: string) => sceneTarget(scene, id)!.type;
const labelOf = (scene: SceneDescription, id: string) => sceneTarget(scene, id)!.item.label;
const currentOf = (scene: SceneDescription, id: string) => { const t = sceneTarget(scene, id)!; return t.type === 'object' ? t.item.description : t.type === 'mark' ? SCENE_MARK_LABELS[t.item.kind] : 'overlaid text'; };
const productish = (o: SceneObject) => ['product', 'object', 'furniture'].includes(o.kind);
/** "Xiaomi phone" from value "phone" and brand "Xiaomi"; a value that already names the brand is used as typed. */
export const brandedValue = (value: string | undefined, brand: string | undefined) => !brand ? value ?? '' : !value ? brand : lower(value).includes(lower(brand)) ? value : `${brand} ${value}`;

/** The brands the image itself shows (product identities read with some confidence, and printed or placed brand marks). */
export const sceneBrands = (scene: SceneDescription) => [...new Set([...scene.objects.filter(o => o.identity?.brand && o.identity.confidence >= 0.5).map(o => o.identity!.brand),
  ...scene.marks.filter(m => m.kind === 'product_brand' && m.text.trim()).map(m => m.text.trim())])];
/** Words that qualify a model ("Pro", "Max", "Note") rather than name its line: never a line name on their own. */
const MODEL_QUALIFIERS = new Set(['pro', 'max', 'plus', 'ultra', 'mini', 'air', 'lite', 'note', 'neo', 'edge', 'series', 'smart', 'new', 'classic', 'one', 'prime', 'active', 'sport', 'go', 'gen', 'edition', 'limited', 'special', 'original', 'standard', 'model', 'the']);
/**
 * A name the artwork may advertise a product under: its brand (the brand, a short form of it, the text of a brand mark
 * printed on it), its own product line, or another product line of its brand. `asWritten` names match only as written.
 */
export interface ProductName { name: string; kind: 'brand' | 'line' | 'brand-line'; asWritten?: boolean }
/**
 * The names a product is advertised under, for any category: from the image first (its brand, the brand marks it carries,
 * its model's leading name: "Kestrel" of "Kestrel 2", never a qualifier like "Pro" or its own category word), then the
 * seed's short forms and product lines of that brand ("Mi" and "Redmi" are Xiaomi's). A brand the analysis read as a
 * product line ("Redmi") counts with the brand it belongs to.
 */
export function productNames(scene: SceneDescription, o: SceneObject): ProductName[] {
  const read = o.identity?.brand?.trim() || undefined, model = o.identity?.model?.trim() ?? '';
  const seedLine = Object.keys(PRODUCT_LINES).find(l => sameBrand(l, read) || (namesWord(model, l) && (!read || sameBrand(PRODUCT_LINES[l], read))));
  const brand = seedBrandOf(read) ?? read ?? (seedLine ? PRODUCT_LINES[seedLine] : undefined);
  const lead = model.split(/\s+/).find(w => !sameBrand(w, brand) && !sameBrand(w, read));
  const line = seedLine ?? (lead && /^\p{L}[\p{L}'’-]{2,}$/u.test(lead) && /\p{Lu}/u.test(lead) && !MODEL_QUALIFIERS.has(lower(lead)) && !namesWord(o.category, lead) ? lead : undefined);
  const names: ProductName[] = [];
  const add = (n: ProductName) => { if (n.name.trim().length >= 2 && !names.some(x => sameBrand(x.name, n.name))) names.push(n); };
  if (brand) add({ name: brand, kind: 'brand' });
  if (line) add({ name: line, kind: 'line', asWritten: !seedLine });
  for (const m of scene.marks.filter(m => m.ownerId === o.id && m.kind === 'product_brand' && m.text.trim())) add({ name: m.text.trim(), kind: 'brand', asWritten: m.text.trim().length <= 3 });
  const seed = seedNamesOf(brand);
  for (const name of seed.aliases) add({ name, kind: 'brand' });
  for (const name of seed.lines) add({ name, kind: 'brand-line' });
  return names;
}
export interface PlanContext {
  /** Detected objects → the template fields they fill (mapSceneToSlots). */
  slots?: Record<string, string>;
  slotRoles?: Record<string, TemplateRole>;
}
/**
 * The deterministic plan: every explicit edit, everything else inherited, and the dependent changes rules can decide
 * from the scene's own relations. No model call.
 */
export function basePlan(scene: SceneDescription, draft: SceneDraft, context: PlanContext = {}): ChangePlan {
  const entries: PlanEntry[] = [], conflicts: PlanConflict[] = [], notes: string[] = [];
  const slot = (id: string) => context.slots?.[id] ? { slotId: context.slots[id], ...(context.slotRoles?.[context.slots[id]] ? { slotRole: context.slotRoles[context.slots[id]] } : {}) } : {};
  const entry = (e: Omit<PlanEntry, 'id' | 'label' | 'targetType'> & { id?: string }): PlanEntry => {
    const made: PlanEntry = { ...e, id: e.id ?? `${e.source}:${e.targetId}:${e.operation}${e.property ? `:${e.property}` : ''}`, targetType: typeOf(scene, e.targetId), label: labelOf(scene, e.targetId), ...slot(e.targetId) };
    entries.push(made); return made;
  };
  const edits = draft.edits, live = (id: string) => { const t = sceneTarget(scene, id); return !!t && !(t.type === 'object' && t.item.ignored); };
  // 1. Explicit edits, as asked. A brand alone, or a product photo alone, still means something.
  for (const [id, edit] of Object.entries(edits)) {
    if (!live(id)) continue;
    const target = sceneTarget(scene, id)!, object = target.type === 'object' ? target.item : undefined;
    const photo = draft.referenceFor === id;
    if ((edit.action === 'replace' || edit.action === 'modify') && !edit.value && edit.brand && !photo && object) {
      const same = !!object.identity?.brand && lower(object.identity.brand) === lower(edit.brand);
      if (same && edit.action === 'modify') { notes.push(`${object.label} already shows ${edit.brand}; nothing to change for the brand.`); continue; }
      const category = lower(object.category);
      conflicts.push({ id: `rule:identity:${id}`, kind: 'identity-unclear', targetIds: [id], source: 'rule',
        question: same ? `${object.label} already shows ${edit.brand}, and only that brand was given. Which ${edit.brand} product should replace it?`
          : `Only a brand was given for ${object.label}. A ${edit.brand} logo on the current ${category} would misrepresent it. What should it become?`,
        options: [{ id: 'generic', label: `A ${edit.brand} ${category}, no specific model`, effects: [{ kind: 'edit', targetId: id, edit: { action: 'replace', value: `${category}, no specific model`, brand: edit.brand } }] },
          { id: 'describe', label: 'I will describe the exact product', effects: [{ kind: 'focus', targetId: id }] }] });
      continue;
    }
    // The brand the user's own words name, read locally (written out, or a product line of one brand): never a guess.
    const read = object && productish(object) && (edit.action === 'replace' || edit.action === 'modify') ? brandInWords(edit.value, sceneBrands(scene)) : undefined;
    if (read && 'ambiguous' in read) {
      conflicts.push({ id: `rule:product-brand:${id}`, kind: 'product-brand', targetIds: [id], source: 'rule', question: `Your words for ${object!.label} name more than one brand (${joinAnd(read.ambiguous)}). Which brand should it carry?`,
        options: [...read.ambiguous.slice(0, 3).map((b, n): ConflictOption => ({ id: `brand-${n + 1}`, label: `${b}`, effects: [{ kind: 'edit', targetId: id, edit: { ...edit, brand: b } }] })),
          { id: 'describe', label: 'I will describe it again', effects: [{ kind: 'focus', targetId: id }] }] });
      continue;
    }
    if (read && edit.brand && !sameBrand(read.brand, edit.brand)) {
      conflicts.push({ id: `rule:product-brand:${id}`, kind: 'product-brand', targetIds: [id], source: 'rule',
        question: `Your description of ${object!.label} names ${read.via === 'line' ? `${read.line} (a ${read.brand} product line)` : read.brand}, but the brand field says ${edit.brand}. Which brand is it?`,
        options: [{ id: 'words', label: `${read.brand}, as described`, effects: [{ kind: 'edit', targetId: id, edit: { ...edit, brand: read.brand } }] }, { id: 'describe', label: `${edit.brand}: I will fix the description`, effects: [{ kind: 'focus', targetId: id }] }] });
      continue;
    }
    const brand = edit.brand ?? (read && !('ambiguous' in read) ? read.brand : undefined);
    const to = edit.action === 'replace' ? photo && !edit.value ? `the ${brand ? `${brand} ` : ''}product shown in the attached product photo` : brandedValue(edit.value, brand) : edit.value;
    entry({ targetId: id, operation: edit.action, source: 'explicit', reason: edit.action === 'keep' ? 'You chose to keep it.' : 'You asked for this change.',
      ...(edit.property ? { property: edit.property } : {}), from: currentOf(scene, id), ...(to ? { to } : {}), ...(brand ? { brand } : {}), ...(photo ? { reference: true } : {}) });
    if (read && !('ambiguous' in read) && !edit.brand) entry({ targetId: id, operation: 'modify', property: 'brand', to: read.brand, source: 'inferred',
      reason: read.via === 'line' ? `${read.line} is a ${read.brand} product line.` : 'Your description names this brand.' });
  }
  const explicit = (id: string) => edits[id];
  const conflictOnce = (c: PlanConflict) => { if (!conflicts.some(x => x.id === c.id)) conflicts.push(c); };
  const keepOrRemove = (id: string, question: string, removeLabel: string, kind: ConflictKind = 'dependency') => conflictOnce({ id: `rule:${kind}:${id}`, kind, targetIds: [id], source: 'rule', question,
    options: [{ id: 'remove', label: removeLabel, effects: [{ kind: 'edit', targetId: id, edit: { action: 'remove' } }] }, { id: 'keep', label: 'Keep it anyway', effects: [{ kind: 'edit', targetId: id, edit: { action: 'keep', confirmed: true } }] }] });
  // 2. What the explicit changes take along. A rule never overrides an explicit choice: a contradiction is asked.
  for (const e of [...entries]) {
    if (e.source !== 'explicit' || e.targetType !== 'object') continue;
    const o = scene.objects.find(x => x.id === e.targetId)!, phrase = o.label;
    // A product given another brand keeps its shape, but not the old brand's marks or claims.
    const rebranded = e.operation === 'modify' && !!e.brand && (!o.identity?.brand || lower(o.identity.brand) !== lower(e.brand));
    if (rebranded) {
      for (const m of scene.marks.filter(m => m.ownerId === o.id && !m.overlay)) {
        const own = explicit(m.id);
        if (!own) entry({ targetId: m.id, operation: 'remove', source: 'inferred', from: SCENE_MARK_LABELS[m.kind], reason: `${phrase} now carries the ${e.brand} brand; the old brand's marking goes.` });
        else if (own.action === 'keep' && !own.confirmed) keepOrRemove(m.id, `${phrase} now carries the ${e.brand} brand, but you kept ${m.label}. Keep both brands on it?`, 'Remove the old mark');
      }
      for (const t of scene.overlays.filter(t => t.refersTo.includes(o.id))) if (!explicit(t.id)) entry({ targetId: t.id, operation: 'remove', source: 'inferred', from: 'overlaid text', reason: `It refers to ${phrase} under its old brand; claims never transfer to another brand.` });
    }
    // The old brand advertised on the artwork, and text naming the old product, once that product is gone, replaced or
    // rebranded: under any of its names (productNames: its brand, a short form, a brand mark it carries, its line, its
    // model). A replacement of the same brand keeps the brand's logos and lines, and loses only its old line and model.
    // A logo or line that may as well be about another kept product is asked about, not removed; merchant, bank and
    // partner logos are other entities and never change here.
    const oldBrand = o.identity?.brand, brandGoes = e.operation === 'remove' || rebranded || (e.operation === 'replace' && !sameBrand(e.brand, oldBrand));
    if ((brandGoes || e.operation === 'replace') && productish(o)) {
      const gone = e.operation === 'remove' ? 'removed' : e.operation === 'replace' ? 'replaced' : `now ${e.brand}`;
      const names = productNames(scene, o), now = e.operation === 'remove' ? '' : e.to ?? '';
      const brandOf = names.find(n => n.kind === 'brand')?.name;
      const kept = scene.objects.filter(x => x.id !== o.id && !x.ignored && explicit(x.id)?.action !== 'remove' && explicit(x.id)?.action !== 'replace');
      const sameBrandKept = kept.filter(x => !!x.identity?.brand && x.identity.confidence >= 0.6 && names.some(n => n.kind === 'brand' && (sameBrand(x.identity!.brand, n.name) || sameBrand(seedBrandOf(x.identity!.brand), n.name))));
      /** The kept products a name may as well be about: the same brand; the same line; for another line of the brand, also an unidentified product. */
      const sharedBy = (n: ProductName) => n.kind === 'brand' ? sameBrandKept : n.kind === 'line' ? kept.filter(x => namesWord(x.identity?.model ?? '', n.name) || sameBrand(x.identity?.brand, n.name))
        : [...sameBrandKept, ...kept.filter(x => productish(x) && !x.identity?.brand && !sameBrandKept.includes(x))];
      /** The first of the product's names a text uses (a logo's whole text, in any case) that no longer applies: its brand goes, or its line is not the new one's. */
      const goneName = (text: string, logo = false) => names.find(n => (n.kind === 'line' ? !namesName(now, n.name, n.asWritten) : brandGoes) && (namesName(text, n.name, n.asWritten) || (logo && sameBrand(text.trim(), n.name))));
      const what = (n: ProductName) => n.kind === 'line' ? `${n.name}, the product line of ${phrase}` : n.kind === 'brand-line' ? `${n.name}, a ${brandOf} product line`
        : sameBrand(n.name, oldBrand) || (!oldBrand && sameBrand(n.name, brandOf)) ? `the ${n.name} brand` : `${n.name}, the ${brandOf && !sameBrand(brandOf, n.name) ? `${brandOf} ` : ''}brand of ${phrase}`;
      const stale = (id: string, label: string, why: string, shared: SceneObject[]) => {
        if (entries.some(x => x.targetId === id && x.source === 'inferred')) return;
        const own = explicit(id);
        if (own) { if (own.action === 'keep' && !own.confirmed) keepOrRemove(id, `${label} ${why}, but you kept it. Keep it on the new creative?`, `Remove ${label}`); return; }
        if (shared.length) keepOrRemove(id, `${label} ${why}. It may also be about ${joinAnd(shared.map(x => x.label))}, which stays. Keep it?`, `Remove ${label}`);
        else entry({ targetId: id, operation: 'remove', source: 'inferred', from: sceneTarget(scene, id)!.type === 'overlay' ? 'overlaid text' : SCENE_MARK_LABELS[(sceneTarget(scene, id)!.item as SceneMark).kind], reason: `It ${why}; ${phrase} is ${gone}, and claims or brands never transfer to something else.` });
      };
      for (const m of scene.marks.filter(m => m.overlay && (m.kind === 'product_brand' || m.kind === 'other_logo'))) {
        const n = goneName(m.text, true);
        if (m.ownerId === o.id && brandGoes) stale(m.id, m.label, `shows the ${oldBrand ?? 'old'} brand of ${phrase} on the artwork`, []);
        else if (n && (!m.ownerId || m.ownerId === o.id)) stale(m.id, m.label, n.kind === 'brand' && sameBrand(n.name, oldBrand) ? `shows the ${oldBrand} brand of ${phrase} on the artwork` : `shows ${what(n)}, on the artwork`, m.ownerId === o.id ? [] : sharedBy(n));
      }
      const model = o.identity?.model?.trim(), shortModel = model?.split(/\s+/).slice(0, 2).join(' ');
      const modelGoes = !!model && !namesWord(now, model);
      for (const t of scene.overlays.filter(t => !t.refersTo.includes(o.id))) {
        const namesModel = modelGoes && (namesWord(t.text, model!) || (!!shortModel && shortModel !== model && /\d/.test(shortModel) && namesWord(t.text, shortModel)));
        const n = namesModel ? undefined : goneName(t.text);
        if (namesModel) stale(t.id, t.label, `names ${phrase}'s model (${model})`, []);
        else if (n) stale(t.id, t.label, `names ${what(n)}`, sharedBy(n));
      }
    }
    if (e.operation === 'replace' || e.operation === 'remove') {
      const gone = e.operation === 'remove' ? 'removed' : 'replaced';
      // a. Marks printed on it belong to it: a new product carries only its own.
      for (const m of scene.marks.filter(m => m.ownerId === o.id && !m.overlay)) {
        const own = explicit(m.id);
        if (!own) entry({ targetId: m.id, operation: 'remove', source: 'inferred', from: SCENE_MARK_LABELS[m.kind], reason: `It is printed on ${phrase}, which is ${gone}; a new product carries only its own markings.` });
        else if (own.action === 'keep' && !own.confirmed) keepOrRemove(m.id, `${m.label} is printed on ${phrase}, which you ${gone}. Keep that mark on the new creative?`, 'Remove the old mark');
      }
      // b. Offer text about it never transfers to something else.
      for (const t of scene.overlays.filter(t => t.refersTo.includes(o.id))) {
        const own = explicit(t.id);
        if (!own) entry({ targetId: t.id, operation: 'remove', source: 'inferred', from: 'overlaid text', reason: `It refers to ${phrase}, which is ${gone}; offers and claims never transfer to another product.` });
        else if (own.action === 'keep' && !own.confirmed) keepOrRemove(t.id, `${t.label} refers to ${phrase}, which you ${gone}. Its offer or claim would not be true of the new creative. Keep it?`, 'Remove the text');
      }
      // c. Accessories: asked only on evidence; unrelated or uncertain companions stay. A product of the same brand is
      // its own product: it stays, with a note (asking would be a question nobody needs to answer).
      for (const r of scene.relations.filter(r => (r.relation === 'accessory_of' && r.target === o.id) || (r.relation === 'same_brand_as' && (r.source === o.id || r.target === o.id)))) {
        const other = r.source === o.id ? r.target : r.source, a = scene.objects.find(x => x.id === other);
        if (!a || a.ignored || explicit(other)) continue;
        if (r.relation === 'same_brand_as') { if (!notes.some(n => n.startsWith(`${a.label} shows the same brand`))) notes.push(`${a.label} shows the same brand as ${phrase}; it stays as it is unless you change it.`); continue; }
        if (r.confidence >= 0.7) conflictOnce({ id: `rule:accessory:${other}`, kind: 'accessory', targetIds: [other, o.id], source: 'rule',
          question: `${a.label} looks like an accessory of ${phrase}${r.evidence ? ` (${r.evidence})` : ''}, which you ${gone}. What should happen to it?`,
          options: [{ id: 'keep', label: `Keep ${a.label}`, effects: [{ kind: 'edit', targetId: other, edit: { action: 'keep' } }] }, { id: 'remove', label: `Remove ${a.label}`, effects: [{ kind: 'edit', targetId: other, edit: { action: 'remove' } }] },
            { id: 'replace', label: `Replace ${a.label} too`, effects: [{ kind: 'focus', targetId: other }] }] });
        else notes.push(`${a.label} may belong with ${phrase} (uncertain); it is kept unless you change it.`);
      }
      // c2. Other copies of the same product (the same kind, by the same brand, or both unbranded: other colours of it, say)
      // are part of what was advertised: changing one is a real choice for the rest, so it is asked once, never assumed.
      if (e.operation === 'replace' && productish(o)) {
        const sameKind = scene.objects.filter(x => x.id !== o.id && !x.ignored && productish(x) && !explicit(x.id) && lower(x.category) === lower(o.category) && !holderOf(scene, x.id)
          && (sameBrand(x.identity?.brand, o.identity?.brand) || (!x.identity?.brand && !o.identity?.brand) || scene.relations.some(r => r.relation === 'same_brand_as' && [r.source, r.target].includes(x.id) && [r.source, r.target].includes(o.id))));
        if (sameKind.length) {
          const them = sameKind.length === 1 ? sameKind[0].label : `the other ${sameKind.length} ${lower(o.category)}s`, edit = draft.edits[o.id];
          conflictOnce({ id: `rule:set:${o.id}`, kind: 'dependency', targetIds: [...sameKind.map(x => x.id), o.id], source: 'rule',
            question: `${sameKind.length === 1 ? `${sameKind[0].label} looks like` : `${them[0].toLocaleUpperCase()}${them.slice(1)} look like`} the same product as ${phrase}${o.identity?.brand ? ` (${o.identity.brand})` : ''}, perhaps in other colours. You replaced ${phrase}: what should happen to ${sameKind.length === 1 ? 'it' : 'them'}?`,
            options: [{ id: 'replace', label: `Replace ${sameKind.length === 1 ? 'it' : 'them'} with ${e.to ? `"${e.to}"` : 'the new product'} too`, effects: sameKind.map(x => ({ kind: 'edit' as const, targetId: x.id, edit: { action: 'replace' as const, ...(edit?.value ? { value: edit.value } : {}), ...(e.brand ? { brand: e.brand } : {}) } })) },
              { id: 'remove', label: `Remove ${sameKind.length === 1 ? 'it' : 'them'}`, effects: sameKind.map(x => ({ kind: 'edit' as const, targetId: x.id, edit: { action: 'remove' as const } })) },
              { id: 'keep', label: `Keep ${sameKind.length === 1 ? 'it' : 'them'} as ${sameKind.length === 1 ? 'it is' : 'they are'}`, effects: sameKind.map(x => ({ kind: 'edit' as const, targetId: x.id, edit: { action: 'keep' as const } })) }] });
        }
      }
      // d. What it holds, wears or has as parts. A replaced object's own parts go with it (a new person may hold the same things).
      const parts = new Set(scene.relations.filter(r => (r.relation === 'part_of' || r.relation === 'attached_to') && r.target === o.id).map(r => r.source));
      for (const child of attachedTo(scene, o.id)) {
        const c = scene.objects.find(x => x.id === child);
        if (!c || c.ignored) continue;
        const own = explicit(child);
        if (e.operation === 'replace' && parts.has(child)) {
          if (!own) entry({ targetId: child, operation: 'remove', source: 'inferred', from: c.description, reason: `It is part of ${phrase}, which is replaced; no part of the original may remain.` });
          else if (own.action === 'keep' && !own.confirmed) keepOrRemove(child, `${c.label} is part of ${phrase}, which you replaced. Keep it on the new one?`, `Remove ${c.label}`);
        }
        if (e.operation === 'remove') {
          if (!own) entry({ targetId: child, operation: 'remove', source: 'inferred', from: c.description, reason: `It is held, worn or attached by ${phrase}, which is removed.` });
          else if (own.action !== 'remove' && !own.confirmed) conflictOnce({ id: `rule:dependency:${child}`, kind: 'dependency', targetIds: [child, o.id], source: 'rule',
            question: `You removed ${phrase}, but ${c.label} is held, worn or attached by it. What should happen?`,
            options: [{ id: 'remove-both', label: `Remove ${c.label} too`, effects: [{ kind: 'edit', targetId: child, edit: { action: 'remove' } }] },
              { id: 'keep-holder', label: `Keep ${phrase}`, effects: [{ kind: 'edit', targetId: o.id, edit: { action: 'keep' } }] }] });
        }
      }
      // e. The hand around a held object.
      const holder = holderOf(scene, o.id), h = holder ? scene.objects.find(x => x.id === holder) : undefined;
      if (h && !h.ignored && explicit(holder!)?.action === 'keep') notes.push(`You kept ${h.label} exactly: the hand is not adjusted, so the new object may not sit naturally in it.`);
      else if (h && !h.ignored && (!explicit(holder!) || explicit(holder!)!.action === 'modify')) {
        entry({ targetId: holder!, operation: 'adjust', property: e.operation === 'replace' ? 'grip' : 'hand', source: 'inferred', from: h.description,
          to: e.operation === 'replace' ? 'the hand holds the new object naturally' : 'the empty hand rests naturally',
          reason: `${h.label} ${scene.relations.some(r => r.relation === 'wears' && r.target === o.id) ? 'wears' : 'holds'} ${phrase}, which is ${gone}.` });
      }
      if (e.operation === 'replace' && productish(o) && !e.brand && !e.reference) notes.push(`No brand was given for the new ${lower(o.category)}, and your words name none: it is drawn with no brand name or logo.`);
    }
  }
  // 3. Everything else stays: inherited, not "an empty field".
  const touched = new Set(entries.map(e => e.targetId));
  const inherit = (id: string, from: string) => { if (!touched.has(id)) entry({ targetId: id, operation: 'keep', source: 'inherited', from, reason: 'Not changed: kept as it is.' }); };
  for (const o of scene.objects) if (!o.ignored) inherit(o.id, o.description);
  for (const m of scene.marks) inherit(m.id, SCENE_MARK_LABELS[m.kind]);
  for (const t of scene.overlays) inherit(t.id, 'overlaid text');
  return finish({ entries, conflicts, notes, status: 'clear' });
}
function finish(plan: ChangePlan): ChangePlan {
  const changes = plan.entries.some(e => e.operation !== 'keep');
  return { ...plan, status: plan.conflicts.length ? 'needs-input' : changes ? 'clear' : 'unchanged' };
}
/** Whether a resolver model can add anything: identity, brands, photos and object changes. Restyles and removals resolve by rule. */
export function needsResolver(scene: SceneDescription, draft: SceneDraft): boolean {
  if (draft.referenceFor) return true;
  return Object.entries(draft.edits).some(([id, e]) => {
    const t = sceneTarget(scene, id);
    if (e.brand) return true;
    if (t?.type !== 'object' || !isForeground(t.item)) return false;
    // A different object, or a product's details: identity and brand may follow. A person's clothing resolves by rule.
    return e.action === 'replace' || (e.action === 'modify' && productish(t.item));
  });
}

/** A resolver model's proposal (validated by parseResolverProposal before use). */
export interface ResolverProposal {
  understanding: { targetId: string; brand: string; brandSource: 'explicit' | 'inferred' | 'photo' | 'none'; identity: string; specificity: 'exact_model' | 'brand_and_category' | 'category_only' | 'unclear' }[];
  inferred: { targetId: string; operation: 'modify' | 'replace' | 'remove' | 'adjust'; property: string; to: string; reason: string; evidence: string; confidence: number }[];
  conflicts: { kind: ConflictKind; targetIds: string[]; question: string; options: { label: string; targetId: string; action: ObjectAction | 'remove_reference'; value: string; brand: string }[] }[];
  productPhoto: { present: boolean; category: string; brand: string; evidence: string; matchesRequest: 'yes' | 'no' | 'unclear'; description: string };
}
export class ResolverValidationError extends Error { constructor(message: string) { super(message); this.name = 'ResolverValidationError'; } }
const CONFLICT_KINDS: readonly ConflictKind[] = ['product-brand', 'image-text', 'accessory', 'identity-unclear', 'dependency', 'uncertain-inference', 'other'];
/** The proposal's shape, strictly (a malformed answer is rejected whole, never used in part). Ids are checked against the scene later. */
export function parseResolverProposal(value: unknown): ResolverProposal {
  const bad = (why: string): never => { throw new ResolverValidationError(`The resolver's answer is invalid: ${why}`); };
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('not an object.');
  const list = (key: string, max: number) => { const x = v[key]; if (!Array.isArray(x) || x.length > max) return bad(`${key} must be a list of at most ${max}.`); return x as Record<string, unknown>[]; };
  const str = (x: unknown, what: string) => typeof x === 'string' ? x : bad(`${what} must be text.`);
  const unit = (x: unknown, what: string) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : bad(`${what} must be between 0 and 1.`);
  const understanding = list('understanding', 12).map(u => ({ targetId: str(u.target_id, 'target_id'), brand: str(u.brand, 'brand'),
    brandSource: (['explicit', 'inferred', 'photo', 'none'].includes(u.brand_source as string) ? u.brand_source : bad('brand_source')) as ResolverProposal['understanding'][number]['brandSource'],
    identity: str(u.identity, 'identity'), specificity: (['exact_model', 'brand_and_category', 'category_only', 'unclear'].includes(u.specificity as string) ? u.specificity : bad('specificity')) as ResolverProposal['understanding'][number]['specificity'] }));
  const inferred = list('inferred_changes', 20).map(i => ({ targetId: str(i.target_id, 'target_id'), operation: (['modify', 'replace', 'remove', 'adjust'].includes(i.operation as string) ? i.operation : bad('operation')) as ResolverProposal['inferred'][number]['operation'],
    property: str(i.property, 'property'), to: str(i.to, 'to'), reason: str(i.reason, 'reason'), evidence: str(i.evidence, 'evidence'), confidence: unit(i.confidence, 'confidence') }));
  const conflicts = list('conflicts', 6).map(c => {
    const options = Array.isArray(c.options) && c.options.length >= 2 && c.options.length <= 4 ? c.options as Record<string, unknown>[] : bad('each conflict needs 2–4 options.');
    const targetIds = Array.isArray(c.target_ids) && c.target_ids.length >= 1 && c.target_ids.length <= 4 && c.target_ids.every(t => typeof t === 'string') ? c.target_ids as string[] : bad('target_ids');
    return { kind: (CONFLICT_KINDS.includes(c.kind as ConflictKind) ? c.kind : bad('conflict kind')) as ConflictKind, targetIds, question: str(c.question, 'question'),
      options: options.map(o => ({ label: str(o.label, 'option label'), targetId: str(o.target_id, 'option target_id'), action: ([...OBJECT_ACTIONS, 'remove_reference'].includes(o.action as string) ? o.action : bad('option action')) as ObjectAction | 'remove_reference',
        value: str(o.value, 'option value'), brand: str(o.brand, 'option brand') })) };
  });
  const p = v.product_photo as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return bad('product_photo is missing.');
  const productPhoto = { present: p.present === true, category: str(p.category, 'photo category'), brand: str(p.brand, 'photo brand'), evidence: str(p.evidence, 'photo evidence'),
    matchesRequest: (['yes', 'no', 'unclear'].includes(p.matches_request as string) ? p.matches_request : bad('matches_request')) as 'yes' | 'no' | 'unclear', description: str(p.description, 'photo description') };
  return { understanding, inferred, conflicts, productPhoto };
}

/** Offers, prices, dates and specifications the user never wrote: a resolver may never add them. */
const INVENTED = /₹|\$|€|%|\b(?:rs\.?|inr|usd|emi|cashback|discount|off|sale|offer|free|deal|price|warranty|guarantee|eligib\w*|tenure|valid till|limited time)\b|\b\d+\s?(?:gb|tb|mb|mp|mah|hz|ghz|w|inch|inches|in|mm|cm|kg|l|litre|liters?|star|k)\b/i;
const digits = (text: string) => text.match(/\d+/g) ?? [];
/** A value adds facts nobody gave: a number, a price, an offer or a spec that is not in the user's own words or the image's evidence. */
export function inventsFacts(value: string, allowed: string): boolean {
  const known = new Set(digits(allowed)), lowerAllowed = lower(allowed);
  if (digits(value).some(d => !known.has(d))) return true;
  const match = value.match(INVENTED);
  return !!match && !lowerAllowed.includes(lower(match[0]));
}
const ALLOWED_INFERRED: Record<'object' | 'mark' | 'overlay', readonly ResolverProposal['inferred'][number]['operation'][]> = { object: ['modify', 'replace', 'remove', 'adjust'], mark: ['remove'], overlay: ['remove'] };
/**
 * The deterministic plan plus what a resolver proposed, after validation: unknown ids, operations an item does not allow,
 * changes to explicitly edited items, invented facts and contradicting brands are rejected (listed in `rejected`). An
 * uncertain inference becomes a question. The result is never less safe than the base plan.
 */
export function mergeResolution(scene: SceneDescription, draft: SceneDraft, base: ChangePlan, proposal: ResolverProposal): { plan: ChangePlan; rejected: string[] } {
  const entries = base.entries.map(e => ({ ...e })), conflicts = [...base.conflicts], notes = [...base.notes], rejected: string[] = [];
  const userWords = Object.values(draft.edits).flatMap(e => [e.value ?? '', e.brand ?? '']).join(' ');
  /** Whether an item's own words name this word (whole words only: "Mi" is not in "minimal"). */
  const names = (id: string, word: string) => { const e = draft.edits[id]; return !!e && new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(`${e.value ?? ''} ${e.brand ?? ''}`); };
  const evidence = `${userWords} ${scene.objects.map(o => `${o.description} ${o.identity?.brand ?? ''} ${o.identity?.model ?? ''} ${o.properties.map(p => p.value).join(' ')}`).join(' ')} ${proposal.productPhoto.present ? `${proposal.productPhoto.brand} ${proposal.productPhoto.description}` : ''}`;
  const live = (id: string) => { const t = sceneTarget(scene, id); return t && !(t.type === 'object' && t.item.ignored) ? t : undefined; };
  // 1. What the resolver understood of each requested product: a brand only from the user's words or a photo it saw.
  for (const u of proposal.understanding) {
    const e = entries.find(x => x.targetId === u.targetId && x.source === 'explicit' && (x.operation === 'replace' || x.operation === 'modify'));
    if (!e) { rejected.push(`Understanding of an item you did not change (${cleanSceneText(u.targetId, 40)}).`); continue; }
    const brand = cleanSceneText(u.brand, BRAND_LIMIT);
    if (!brand) continue;
    if (e.brand) { if (!sameBrand(brand, e.brand)) rejected.push(`A brand (${brand}) other than the one you gave or your words name (${e.brand}).`); continue; }
    const fromWords = names(e.targetId, brand), fromPhoto = draft.referenceFor === e.targetId && proposal.productPhoto.present && lower(proposal.productPhoto.brand) === lower(brand) && !!proposal.productPhoto.evidence.trim();
    // Accepted on evidence, whatever the resolver called it: the user's own words name it, or the photo it saw shows it.
    if (fromWords || (u.brandSource === 'photo' && fromPhoto)) {
      e.brand = brand;
      const object = scene.objects.find(o => o.id === e.targetId), category = object?.category;
      if (category) { const stale = notes.findIndex(n => n.startsWith(`No brand was given for the new ${lower(category)}`)); if (stale >= 0) notes.splice(stale, 1); }
      // A product changed to another brand loses the old brand's marks and claims, as if the brand had been typed.
      if (object && e.operation === 'modify' && (!object.identity?.brand || lower(object.identity.brand) !== lower(brand))) {
        const inheritedKeep = (id: string) => entries.findIndex(x => x.targetId === id && x.source === 'inherited');
        for (const m of scene.marks.filter(m => m.ownerId === object.id && !m.overlay)) {
          const own = draft.edits[m.id], at = inheritedKeep(m.id);
          if (!own && at >= 0) entries.splice(at, 1, { id: `inferred:${m.id}:remove`, targetId: m.id, targetType: 'mark', label: m.label, operation: 'remove', from: SCENE_MARK_LABELS[m.kind], source: 'inferred', reason: `${object.label} now carries the ${brand} brand; the old brand's marking goes.` });
          else if (own?.action === 'keep' && !own.confirmed && !conflicts.some(c => c.id === `rule:dependency:${m.id}`)) conflicts.push({ id: `rule:dependency:${m.id}`, kind: 'dependency', targetIds: [m.id], source: 'rule',
            question: `${object.label} now carries the ${brand} brand, but you kept ${m.label}. Keep both brands on it?`, options: [{ id: 'remove', label: 'Remove the old mark', effects: [{ kind: 'edit', targetId: m.id, edit: { action: 'remove' } }] }, { id: 'keep', label: 'Keep it anyway', effects: [{ kind: 'edit', targetId: m.id, edit: { action: 'keep', confirmed: true } }] }] });
        }
        for (const t of scene.overlays.filter(t => t.refersTo.includes(object.id))) {
          const at = inheritedKeep(t.id);
          if (!draft.edits[t.id] && at >= 0) entries.splice(at, 1, { id: `inferred:${t.id}:remove`, targetId: t.id, targetType: 'overlay', label: t.label, operation: 'remove', from: 'overlaid text', source: 'inferred', reason: `It refers to ${object.label} under its old brand; claims never transfer to another brand.` });
        }
      }
      entries.push({ id: `inferred:${e.targetId}:modify:brand`, targetId: e.targetId, targetType: e.targetType, label: e.label, ...(e.slotId ? { slotId: e.slotId } : {}), ...(e.slotRole ? { slotRole: e.slotRole } : {}), operation: 'modify', property: 'brand', to: brand, source: 'inferred',
        reason: !fromWords ? 'The product photo shows this brand.' : 'Your description names this brand.', evidence: !fromWords ? cleanSceneText(proposal.productPhoto.evidence) : undefined });
    } else rejected.push(`A brand (${brand}) that neither your words nor the product photo show.`);
    if (u.specificity === 'exact_model' && !/\d/.test(userWords) && !fromPhoto) notes.push(`${e.label}: no exact model was given, so none is drawn.`);
  }
  // 2. Inferred dependent changes.
  for (const i of proposal.inferred) {
    const target = live(i.targetId);
    if (!target) { rejected.push(`A change to an unknown item (${cleanSceneText(i.targetId, 40)}).`); continue; }
    if (!ALLOWED_INFERRED[target.type].includes(i.operation) || (target.type === 'object' && target.item.kind === 'scenery' && target.item.importance === 'background' && !['modify', 'adjust'].includes(i.operation))) { rejected.push(`${target.item.label} cannot be changed that way (${i.operation}).`); continue; }
    if (draft.edits[i.targetId]) { rejected.push(`${target.item.label}: your own choice stands.`); continue; }
    const to = cleanSceneText(i.to, 160), reason = cleanSceneText(i.reason, 200) || 'It depends on a change you asked for.';
    if ((i.operation === 'modify' || i.operation === 'replace' || i.operation === 'adjust') && !to) { rejected.push(`${target.item.label}: a change without a value.`); continue; }
    if (to && inventsFacts(to, evidence)) { rejected.push(`${target.item.label}: "${to}" adds a number, price, offer or specification nobody gave.`); continue; }
    // Changing another object (not just a dependent adjustment) is the user's call, however sure the resolver is.
    if (i.confidence < 0.6 || (target.type === 'object' && i.operation !== 'adjust')) {
      const edit: ObjectEdit = i.operation === 'remove' ? { action: 'remove' } : { action: i.operation === 'adjust' ? 'modify' : i.operation, value: to };
      if (!allowedActions(scene, i.targetId).includes(edit.action)) { rejected.push(`${target.item.label} cannot be changed that way.`); continue; }
      if (conflicts.some(c => c.targetIds.includes(i.targetId))) continue;
      conflicts.push({ id: `resolver:uncertain:${i.targetId}:${i.operation}`, kind: 'uncertain-inference', targetIds: [i.targetId], source: 'resolver', question: `Should ${target.item.label} also change? ${reason}`,
        options: [{ id: 'apply', label: i.operation === 'remove' ? `Remove ${target.item.label}` : `Change it: ${to}`, effects: [{ kind: 'edit', targetId: i.targetId, edit }] },
          { id: 'keep', label: `Keep ${target.item.label} as it is`, effects: [{ kind: 'edit', targetId: i.targetId, edit: { action: 'keep' } }] }] });
      continue;
    }
    const existing = entries.findIndex(e => e.targetId === i.targetId && (e.source === 'inherited' || (e.source === 'inferred' && e.operation === i.operation)));
    const made: PlanEntry = { id: `inferred:${i.targetId}:${i.operation}${i.property ? `:${cleanSceneText(i.property, 20).replace(/\W+/g, '_')}` : ''}`, targetId: i.targetId, targetType: target.type, label: target.item.label,
      ...(entries[existing]?.slotId ? { slotId: entries[existing].slotId } : {}), ...(entries[existing]?.slotRole ? { slotRole: entries[existing].slotRole } : {}),
      operation: i.operation, ...(i.property ? { property: cleanSceneText(i.property, 30) } : {}), from: currentOf(scene, i.targetId), ...(to ? { to } : {}), source: 'inferred', reason, evidence: cleanSceneText(i.evidence) || undefined, confidence: i.confidence };
    if (existing >= 0 && entries[existing].source === 'inherited') entries.splice(existing, 1, made);
    else if (existing >= 0) entries.splice(existing, 1, { ...entries[existing], ...made, id: entries[existing].id });
    else entries.push(made);
  }
  // 3. Conflicts the resolver found, with options that are concrete, allowed edits.
  for (const c of proposal.conflicts) {
    if (c.targetIds.some(id => !live(id))) { rejected.push('A question about an unknown item.'); continue; }
    const options: ConflictOption[] = [];
    for (const [n, o] of c.options.entries()) {
      const label = cleanSceneText(o.label, 120);
      if (!label) continue;
      if (o.action === 'remove_reference') { if (draft.referenceFor) options.push({ id: `o${n + 1}`, label, effects: [{ kind: 'remove-reference' }] }); continue; }
      if (!live(o.targetId) || !allowedActions(scene, o.targetId).includes(o.action)) continue;
      const value = cleanSceneText(o.value, FIELD_LIMIT), brand = cleanSceneText(o.brand, BRAND_LIMIT);
      if ((value && inventsFacts(value, evidence)) || (brand && inventsFacts(brand, evidence))) continue;
      if ((o.action === 'modify' || o.action === 'replace') && !value && !brand) { options.push({ id: `o${n + 1}`, label, effects: [{ kind: 'focus', targetId: o.targetId }] }); continue; }
      const t = sceneTarget(scene, o.targetId)!;
      const brandAllowed = t.type === 'object' && ['product', 'object', 'furniture'].includes(t.item.kind) && ['modify', 'replace'].includes(o.action);
      options.push({ id: `o${n + 1}`, label, effects: [{ kind: 'edit', targetId: o.targetId, edit: { action: o.action, ...(['modify', 'replace'].includes(o.action) && value ? { value } : {}), ...(brandAllowed && brand ? { brand } : {}) } }] });
    }
    if (options.length < 2) { rejected.push('A question without two usable answers.'); continue; }
    const id = `resolver:${c.kind}:${[...c.targetIds].sort().join('+')}`;
    // A question the rules already ask about the same item is asked once.
    if (conflicts.some(x => x.kind === c.kind && x.targetIds.some(t => c.targetIds.includes(t)))) continue;
    if (!conflicts.some(x => x.id === id)) conflicts.push({ id, kind: c.kind, targetIds: c.targetIds, question: cleanSceneText(c.question, 240) || 'Choose how to continue.', options, source: 'resolver' });
  }
  // 4. A product photo that shows something other than what was asked: never silently picked over the words.
  const p = proposal.productPhoto, target = draft.referenceFor;
  if (target && p.present && p.matchesRequest === 'no') {
    const e = entries.find(x => x.targetId === target && x.source === 'explicit'), asked = e?.to ?? '';
    const shown = cleanSceneText(p.description, FIELD_LIMIT) || cleanSceneText(p.category, FIELD_LIMIT);
    if (shown) conflicts.push({ id: `resolver:image-text:${target}`, kind: 'image-text', targetIds: [target], source: 'resolver',
      question: `The product photo looks like ${shown}, but you asked for ${asked ? `"${asked}"` : 'something else'}. Which is right?`,
      options: [{ id: 'photo', label: `Use the photo: ${shown}`, effects: [{ kind: 'edit', targetId: target, edit: { action: 'replace', value: shown, ...(cleanSceneText(p.brand, BRAND_LIMIT) && !inventsFacts(p.brand, evidence) ? { brand: cleanSceneText(p.brand, BRAND_LIMIT) } : {}) } }] },
        { id: 'words', label: 'Use my words and drop the photo', effects: [{ kind: 'remove-reference' }] }] });
  } else if (target && p.present && p.matchesRequest === 'unclear') notes.push('Whether the product photo matches your words could not be told; review the generated image.');
  return { plan: finish({ entries, conflicts, notes, status: 'clear' }), rejected };
}

/** A conflict answer as the user's own explicit choice: the draft it makes (and a field to focus, for "I will describe it"). */
export function applyConflictOption(draft: SceneDraft, option: ConflictOption): { draft: SceneDraft; focus?: string } {
  let next: SceneDraft = { ...draft, edits: { ...draft.edits } }, focus: string | undefined;
  for (const effect of option.effects) {
    if (effect.kind === 'edit') next.edits[effect.targetId] = { ...effect.edit };
    else if (effect.kind === 'remove-reference') { const { referenceFor: _drop, ...rest } = next; void _drop; next = rest; }
    else focus = effect.targetId;
  }
  return { draft: next, ...(focus ? { focus } : {}) };
}

const STRUCTURAL_ROLES: readonly TemplateRole[] = ['main_product', 'supporting_product', 'held_object', 'prop', 'primary_subject', 'secondary_subject', 'headline', 'body_text', 'price', 'cta', 'badge', 'logo', 'backdrop', 'decoration'];
/** Whether the template's saved decomposition plan still describes the creative after this plan. */
export function planCompatibility(plan: ChangePlan): BlueprintCompatibility {
  const structural = plan.entries.filter(e => (e.operation === 'remove' && (e.slotRole ? STRUCTURAL_ROLES.includes(e.slotRole) : e.targetType === 'object'))
    || (e.operation === 'replace' && e.slotRole !== 'primary_subject' && e.slotRole !== 'secondary_subject' && e.targetType === 'object'));
  if (!structural.length) return { status: 'compatible', changedSlots: [], reasons: plan.entries.some(e => e.operation !== 'keep') ? ['Only looks, details or subjects in their saved places change: the saved plan still describes this creative.'] : ['Nothing changes.'] };
  return { status: 'structural-change', changedSlots: [...new Set(structural.map(e => e.slotId ?? e.targetId))],
    reasons: structural.map(e => e.operation === 'remove' ? `${e.label} is removed, so the saved plan's layer for it has nothing to extract.` : `${e.label} becomes "${e.to}": a different object than the one the saved decomposition plan was learned from.`) };
}

export const TEXT_FREE_RULE = 'Do not add any new text, letters, numbers, prices, discounts, offers, captions, badges with lettering, watermarks, brand names or logos.';
export const PROMPT_LIMIT = 6000;
const joinAnd = (parts: string[]) => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
const quote = (text: string) => `"${text}"`;
const living = (o: SceneObject) => o.kind === 'person' || o.kind === 'character' || o.kind === 'animal';
const propertyWord = (p: string) => lower(SCENE_PROPERTY_LABELS[p as keyof typeof SCENE_PROPERTY_LABELS] ?? p);
/** What a sentence keeps of its object: never a part the plan changes ("keep the same clothing" next to a new outfit). */
const kept = (parts: string[], changed: Set<string>) => joinAnd(parts.filter(p => !changed.has(p)));
/** The brand a target's sentence shows (said once, inside its own sentence), if any. */
function shownBrand(group: PlanEntry[]): string | undefined {
  const main = group.find(e => e.operation === 'replace') ?? group.find(e => e.operation === 'modify' && e.property !== 'brand');
  return main?.brand ?? group.find(e => e.property === 'brand')?.to;
}
/**
 * One target's changes as one sentence, in plain words about the scene's own objects. Every change of one object is said
 * together, so nothing it keeps contradicts what changes (a new outfit and a new grip are one instruction).
 */
function sentence(scene: SceneDescription, group: PlanEntry[], productReference: boolean, changedTargets: ReadonlySet<string> = new Set()): string {
  const e = group[0], phrase = targetPhrase(scene, e.targetId), o = scene.objects.find(x => x.id === e.targetId);
  if (e.targetType === 'overlay') return `Remove ${phrase} completely and continue the background design where it was.`;
  if (e.targetType === 'mark') return `Remove ${phrase} completely${e.source === 'inferred' ? '; do not carry the old brand over to anything else' : ''}.`;
  if (!o) return '';
  // What it holds or wears that stays as it is (a held object that changes is described in its own sentence).
  const holds = attachedTo(scene, o.id).filter(id => scene.objects.find(x => x.id === id && !x.ignored)), keptHolds = holds.filter(id => !changedTargets.has(id));
  const remove = group.find(x => x.operation === 'remove'), replace = group.find(x => x.operation === 'replace'), adjust = group.find(x => x.operation === 'adjust');
  const modifies = group.filter(x => x.operation === 'modify' && x.property !== 'brand'), brand = shownBrand(group);
  if (remove) return `Remove ${phrase} completely and continue the surrounding scene where it was.`;
  if (replace) {
    const holder = holderOf(scene, o.id), h = holder ? scene.objects.find(x => x.id === holder) : undefined;
    if (living(o)) return `Replace ${phrase} with ${quote(replace.to ?? '')}, in the same place, scale, pose and facing direction${keptHolds.length ? `, holding or wearing ${keptHolds.length === holds.length ? 'the same objects' : `the same ${keptHolds.map(id => lower(scene.objects.find(x => x.id === id)!.category)).join(' and ')}`}` : ''}${keptHolds.length < holds.length ? `${keptHolds.length ? ',' : ','} holding the new object described below` : ''}.`;
    const reference = replace.reference && productReference ? ' Match it to the second attached image (the product photo), ignoring that photo\'s background.' : '';
    const branding = brand ? ` Show the ${brand} brand only as this product would plainly carry it.` : ' Show no brand name or logo on it.';
    if (h) return `Replace ${phrase}, held by ${objectPhrase(scene, h)}, with ${quote(replace.to ?? '')}. Remove the original completely.${branding} Do not invent model numbers or specifications.${reference}`;
    return `Replace ${phrase} with ${quote(replace.to ?? '')}. Remove the original completely: no part of it may remain. The new one may have a different shape and size; place it where the original stood, at a similar scale and visual weight, with matching lighting, reflections and shadow.${branding} Do not invent model numbers, specifications or logos.${reference}`;
  }
  const changed = new Set(modifies.map(m => m.property ? propertyWord(m.property) : '').filter(Boolean));
  const asked = modifies.map(m => `${m.property ? `${propertyWord(m.property)} → ` : ''}${quote(m.to ?? '')}`).join('; ');
  const adjustment = adjust ? ` Also adjust ${living(o) ? 'the hands' : 'it'}: ${adjust.to}.` : '';
  if (modifies.length) {
    if (o.kind === 'scenery' && o.importance === 'background') return `Restyle ${phrase}: ${asked.replace(/^[^"]*→ /, '')}. Keep it behind everything else and keep every other element in place.`;
    if (living(o)) return `Change ${phrase}: ${asked}.${adjustment} Keep the same ${kept([o.kind === 'animal' ? 'animal' : 'person', 'face', 'pose', 'expression'], changed)}${holds.length ? ', and everything held or worn that is not changed above' : ''}.`;
    const branding = brand ? ` It carries the ${brand} brand only as such a product plainly would; remove any marking of another brand from it.` : '';
    return `Change ${phrase}: ${asked}. It stays the same ${lower(o.category)} in the same ${kept(['place', 'shape', 'pose'], changed)}.${adjustment}${branding}`;
  }
  if (adjust) return `Adjust ${phrase}: ${adjust.to}; keep the same ${living(o) ? 'person, face, clothing and pose' : 'object, shape and place'} otherwise.`;
  if (brand) return `${phrase[0].toLocaleUpperCase()}${phrase.slice(1)} is a ${brand} product; show the brand only as such a product would plainly carry it.`;
  return '';
}
/** Each changed target once, explicit changes first, then in scene order; its entries together. */
function changeGroups(scene: SceneDescription, plan: ChangePlan): PlanEntry[][] {
  const order = new Map([...scene.objects.map(o => o.id), ...scene.marks.map(m => m.id), ...scene.overlays.map(t => t.id)].map((id, i) => [id, i]));
  const changes = plan.entries.filter(e => e.operation !== 'keep').sort((a, b) => (a.source === 'explicit' ? 0 : 1) - (b.source === 'explicit' ? 0 : 1) || (order.get(a.targetId)! - order.get(b.targetId)!));
  const groups = new Map<string, PlanEntry[]>();
  for (const e of changes) groups.set(e.targetId, [...(groups.get(e.targetId) ?? []), e]);
  // The target's own change leads its group (an explicit one before what was inferred for it).
  return [...groups.values()].map(g => [...g].sort((a, b) => (a.source === 'explicit' ? 0 : 1) - (b.source === 'explicit' ? 0 : 1)));
}
/** The exception to the text-free rule: only the brand a changed product itself carries, as its own sentence says. */
export function brandException(scene: SceneDescription, plan: ChangePlan): string | undefined {
  const marks = changeGroups(scene, plan).flatMap(g => {
    const o = scene.objects.find(x => x.id === g[0].targetId), brand = o && g[0].targetType === 'object' && !g.some(x => x.operation === 'remove') ? shownBrand(g) : undefined;
    return brand && o && !living(o) ? [`the ${brand} brand marking on ${g.some(x => x.operation === 'replace') ? 'the new' : 'the'} ${lower(o.category)}`] : [];
  });
  return marks.length ? `The only exception is ${joinAnd([...new Set(marks)])}, shown only as that product plainly carries it, as described above.` : undefined;
}
export interface CompiledResolvedEdit {
  text: string; segments: PromptSegment[];
  /** The changes as the local pixel review reads them (template fields where mapped). */
  changes: EditChange[];
  /** One deterministic line naming every change (the execution's instruction: history and duplicate detection). */
  summary: string;
  compatibility: BlueprintCompatibility;
}
const OPERATION_OF: Record<Exclude<PlanOperation, 'keep'>, EditOperation> = { modify: 'details', replace: 'replace', remove: 'remove', adjust: 'details' };
/**
 * The prompt of a resolved plan: the same text in the preview and in the request. Unchanged items are kept by name,
 * printed marks and overlaid text are kept unless a change removes them, and nothing new may be written — there is no
 * blanket "keep all visible text" that would contradict a removed or replaced brand.
 */
export function compileResolvedEdit(scene: SceneDescription, plan: ChangePlan, options: { productReference?: boolean } = {}): CompiledResolvedEdit {
  if (plan.status === 'needs-input') throw new DraftError('Answer the open questions before generating.');
  const groups = changeGroups(scene, plan), changes = groups.flat();
  // A brand the plan inferred is said once, inside its product's sentence (the summary lists it with that change).
  const shown = changes.filter(e => !(e.property === 'brand' && e.source === 'inferred' && changes.some(x => x.targetId === e.targetId && x.operation !== 'keep' && x !== e)));
  const segments: PromptSegment[] = [{ kind: 'fixed', text: 'Edit the attached advertising creative.' }];
  if (groups.length) {
    segments.push({ kind: 'fixed', text: 'Make these changes:' });
    const changedIds = new Set(changes.map(e => e.targetId));
    groups.forEach((g, i) => segments.push({ kind: 'slot', slotId: g[0].targetId, label: g[0].label, text: `(${i + 1}) ${sentence(scene, g, !!options.productReference, changedIds)}` }));
  } else segments.push({ kind: 'fixed', text: GENERATE_UNCHANGED_INSTRUCTION });
  const changed = new Set(changes.map(e => e.targetId));
  const keptObjects = scene.objects.filter(o => !o.ignored && !changed.has(o.id) && !(o.kind === 'scenery' && o.importance === 'background'));
  const keptMarks = scene.marks.filter(m => !changed.has(m.id)), keptOverlays = scene.overlays.filter(t => !changed.has(t.id));
  const names = keptObjects.map(o => objectPhrase(scene, o));
  if (names.length) segments.push({ kind: 'fixed', text: `Keep everything else exactly as it is: ${joinAnd(names.length > 14 ? [...names.slice(0, 14), 'every other element'] : names)}; keep their positions, sizes, poses, stacking order, colors and lighting.` });
  else segments.push({ kind: 'fixed', text: 'Keep everything not changed above exactly as it is: positions, sizes, poses, stacking order, colors and lighting.' });
  if (keptMarks.length) segments.push({ kind: 'fixed', text: `Keep every logo and printed marking not changed above exactly as it is, where it is (${joinAnd(keptMarks.map(m => markPhrase(scene, m)))}); never move a logo onto another object or swap one brand's logo for another's.` });
  if (keptOverlays.length) segments.push({ kind: 'fixed', text: `Keep the overlaid text not changed above exactly as it is (${joinAnd(keptOverlays.map(overlayPhrase))}); do not rewrite it.` });
  segments.push({ kind: 'fixed', text: changes.some(e => e.operation === 'replace' || e.operation === 'remove') ? 'Add or remove objects only as the changes above require; add nothing else.' : 'Do not add or remove elements.' });
  segments.push({ kind: 'fixed', text: TEXT_FREE_RULE });
  const exception = brandException(scene, plan);
  if (exception) segments.push({ kind: 'fixed', text: exception });
  const text = segments.map(s => s.text).join(' ');
  if (text.length > PROMPT_LIMIT) throw new DraftError(`The prompt would be ${text.length} characters; at most ${PROMPT_LIMIT}. Change fewer things at once.`);
  // Fail closed: a prompt that contradicts itself is never sent (the checks below say which instruction).
  const problems = promptContradictions(scene, plan, text);
  if (problems.length) throw new DraftError(`The prompt would contradict itself: ${problems[0]} Nothing was sent.`);
  // Every changed item is reviewed: by its template field where it fills one, otherwise by itself (its analysis box).
  const roleOf = (e: PlanEntry): TemplateRole => e.slotRole ?? (e.targetType === 'mark' ? 'logo' : e.targetType === 'overlay' ? 'body_text' : sceneTarget(scene, e.targetId)?.type === 'object' && (sceneTarget(scene, e.targetId)!.item as SceneObject).kind === 'scenery' && (sceneTarget(scene, e.targetId)!.item as SceneObject).importance === 'background' ? 'background' : 'prop');
  // A mark printed on a product that is itself replaced or removed is not reviewed on its own: its box lies inside that
  // product's, where the new product's own edges would read as the mark "still there" (the product's check covers it).
  const goneWithProduct = (e: PlanEntry) => e.targetType === 'mark' && changes.some(x => x.targetType === 'object' && (x.operation === 'replace' || x.operation === 'remove') && x.targetId === scene.marks.find(m => m.id === e.targetId)?.ownerId);
  const reviewChanges: EditChange[] = changes.filter(e => e.operation !== 'adjust' && e.property !== 'brand' && !goneWithProduct(e)).map(e => ({ slotId: e.slotId ?? e.targetId, label: e.label, role: roleOf(e),
    operation: e.operation === 'modify' && sceneTarget(scene, e.targetId)?.type === 'object' && (sceneTarget(scene, e.targetId)!.item as SceneObject).kind === 'scenery' ? 'restyle' : OPERATION_OF[e.operation as Exclude<PlanOperation, 'keep'>],
    ...(e.to ? { value: e.to } : {}), sentence: '', structural: e.operation === 'replace' || e.operation === 'remove' }));
  const summary = shown.length ? `resolved: ${shown.map(e => `${e.label}: ${e.operation}${e.to ? ` ${e.to}` : ''}${e.source === 'inferred' ? ' (inferred)' : ''}`).join('; ')}` : 'resolved: no changes';
  return { text, segments, changes: reviewChanges, summary: summary.slice(0, 480), compatibility: planCompatibility(plan) };
}
/**
 * Self-contradictions a compiled prompt must never have (the bugs this compiler once had, kept as checks): a brand to show
 * against the text-free rule with no exception for it, "show no brand" for a product the words name a brand for, a kept
 * list naming something that changes, "keep the same clothing" (or pose, expression, hair) next to a change of it, and
 * "do not add or remove elements" with a replacement or removal.
 */
export function promptContradictions(scene: SceneDescription, plan: ChangePlan, text: string): string[] {
  const problems: string[] = [], groups = changeGroups(scene, plan), changes = groups.flat();
  const asksBrand = /Show the [^.]{1,80}? brand only|carries the [^.]{1,80}? brand only|is a [^.]{1,80}? product; show the brand/.test(text);
  if (asksBrand && text.includes(TEXT_FREE_RULE) && !/The only exception is the [^.]+ brand marking/.test(text)) problems.push('a brand is asked for, but the text-free rule forbids every brand name with no exception for it.');
  for (const e of changes.filter(x => x.operation === 'replace' && x.targetType === 'object')) {
    const read = brandInWords(e.to);
    if (read && !('ambiguous' in read) && new RegExp(`Replace ${targetPhrase(scene, e.targetId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^(]*?Show no brand name or logo`).test(text)) problems.push(`"${e.to}" names ${read.brand}, but the prompt says to show no brand on it.`);
  }
  const segment = (start: string) => { const at = text.indexOf(start); return at < 0 ? '' : text.slice(at, text.indexOf('.', at + start.length) + 1 || undefined); };
  const keptText = [segment('Keep everything else exactly as it is:'), segment('Keep every logo and printed marking not changed above'), segment('Keep the overlaid text not changed above')].join(' ');
  for (const id of new Set(changes.map(e => e.targetId))) { const phrase = targetPhrase(scene, id); if (new RegExp(`(?:[(:,] ?| and )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[,;)]| and )`).test(keptText)) problems.push(`${phrase} is changed but also listed as kept.`); }
  const changedIds = new Set(changes.map(e => e.targetId));
  for (const g of groups) {
    const o = scene.objects.find(x => x.id === g[0].targetId);
    if (!o) continue;
    const own = sentence(scene, g, true, changedIds);
    if (/holding or wearing the same objects/.test(own) && attachedTo(scene, o.id).some(id => changedIds.has(id))) problems.push(`${o.label}: "the same objects" are promised while one of them is replaced or removed.`);
    for (const m of g.filter(x => x.operation === 'modify' && x.property)) if (new RegExp(`keep the same [^.]*\\b${propertyWord(m.property!)}\\b`, 'i').test(own)) problems.push(`${o.label}: its ${propertyWord(m.property!)} changes, yet its sentence keeps the same ${propertyWord(m.property!)}.`);
    if (g.some(x => x.operation === 'adjust') && g.some(x => x.operation === 'modify' && x.property === 'clothing') && /clothing and pose otherwise/.test(text)) problems.push(`${o.label}: a new outfit and a kept outfit in one prompt.`);
  }
  if (changes.some(e => e.operation === 'replace' || e.operation === 'remove') && text.includes('Do not add or remove elements.')) problems.push('objects are replaced or removed, yet the prompt says not to add or remove elements.');
  return problems;
}
/** The reusable base of the smart prompt: the template's saved fields (what a change could touch), the rest locked rules. */
export function baseResolvedPrompt(slots: { id: string; label: string; role: TemplateRole }[]): PromptSegment[] {
  const content = slots.filter(s => !['headline', 'body_text', 'price', 'cta', 'badge'].includes(s.role));
  return [{ kind: 'fixed', text: 'Edit the attached advertising creative. Make these changes:' },
    ...content.map((s): PromptSegment => ({ kind: 'slot', slotId: s.id, label: s.label, text: `{${s.label}}` })),
    { kind: 'fixed', text: 'Keep everything else exactly as it is: {every detected object you did not change}. Keep every logo and printed marking not changed above exactly as it is. Keep the overlaid text not changed above exactly as it is.' },
    { kind: 'fixed', text: 'Add or remove objects only as the changes above require; add nothing else.' }, { kind: 'fixed', text: TEXT_FREE_RULE }];
}
export const SMART_TEXT_ROLES: readonly TemplateRole[] = ['headline', 'body_text', 'price', 'cta', 'badge'];
export const roleLabel = (role: TemplateRole) => TEMPLATE_ROLE_LABELS[role];
