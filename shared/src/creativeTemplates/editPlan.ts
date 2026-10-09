/**
 * The canonical image-edit compiler of a creative template: the user's field values become explicit operations (replace
 * a product, change its details, restyle the background, set exact text, remove a product's companions), compiled
 * locally — no model call — into ONE prompt. The wizard's preview and the server's request use this same function, so
 * the prompt the user reads is the prompt that is sent.
 *
 * A template keeps roles and positions, never what one image showed. The prompt is built from the saved structure
 * (roles, zones, relations), so templates saved before this compiler existed get the same coherent prompt: their older
 * "change one thing, add or remove nothing" text forbade the very replacements users ask for.
 */
import { TEMPLATE_ROLE_LABELS, type TemplateRole, type TemplateZone } from './roles.js';
import type { TemplateLayer, TemplateVersion } from './types.js';
import { GENERATE_UNCHANGED_INSTRUCTION, sanitizeEditInstruction } from './editPrompt.js';
import { brandInWords, namesWord } from './brands.js';

export const ZONE_PHRASES: Record<TemplateZone, string> = { 'top-left': 'at the top left', 'top-center': 'at the top', 'top-right': 'at the top right', 'middle-left': 'on the left',
  center: 'in the center', 'middle-right': 'on the right', 'bottom-left': 'at the bottom left', 'bottom-center': 'at the bottom', 'bottom-right': 'at the bottom right', 'full-canvas': 'across the whole canvas' };
const ZONE_SHORT: Record<TemplateZone, string> = { 'top-left': 'top left', 'top-center': 'top', 'top-right': 'top right', 'middle-left': 'left', center: 'center',
  'middle-right': 'right', 'bottom-left': 'bottom left', 'bottom-center': 'bottom', 'bottom-right': 'bottom right', 'full-canvas': 'whole canvas' };

/** object: a thing that can be replaced; style: how the scene looks; text: exact copy. */
export type SlotKind = 'object' | 'style' | 'text';
/** Where a field is offered: the few common controls first, everything else under Advanced elements. */
export type SlotGroup = 'product' | 'subject' | 'style' | 'text' | 'advanced';
const KIND: Record<TemplateRole, SlotKind> = { background: 'style', backdrop: 'style', decoration: 'style', effect: 'style', prop: 'style',
  primary_subject: 'object', secondary_subject: 'object', held_object: 'object', main_product: 'object', supporting_product: 'object',
  headline: 'text', body_text: 'text', price: 'text', cta: 'text', badge: 'text', logo: 'text' };
const GROUP: Partial<Record<TemplateRole, SlotGroup>> = { main_product: 'product', primary_subject: 'subject', held_object: 'subject', background: 'style', backdrop: 'style',
  headline: 'text', body_text: 'text', price: 'text', cta: 'text', badge: 'text' };
const EXAMPLES: Partial<Record<TemplateRole, string>> = { main_product: 'e.g. Bluetooth speaker', supporting_product: 'e.g. matching earbuds, or leave empty to keep',
  primary_subject: 'e.g. young man in a blue jacket', secondary_subject: 'e.g. smiling woman', held_object: 'e.g. football', background: 'e.g. warm yellow gradient, soft studio light',
  backdrop: 'e.g. teal circle with a soft glow', decoration: 'e.g. diwali diyas instead of bars', prop: 'e.g. white cylinder pedestal', headline: 'Exact headline text',
  body_text: 'Exact text', price: 'Exact price, e.g. ₹1,999', cta: 'Exact button text, e.g. Shop now', badge: 'Exact badge text, e.g. NEW', logo: 'Exact brand name as plain text' };
const HINTS: Record<SlotKind, string> = { object: 'Describe the new object. Leave empty to keep the original.', style: 'Describe the new look. Leave empty to keep the original.',
  text: 'Used exactly as typed. Leave empty to keep the original text.' };

export interface TemplateSlot {
  id: string; role: TemplateRole; kind: SlotKind; group: SlotGroup;
  /** A label that tells same-role slots apart: "Supporting product · top left". */
  label: string; zone?: TemplateZone; placeholder: string; hint: string;
  /** Kept in its parent's decomposition layer (a held ball): its content can still change. */
  groupedWith?: string;
}
/** The fields a template offers, back to front, with meaningful labels. Effects (shadows, glows) are not content. */
export function describeTemplateSlots(version: Pick<TemplateVersion, 'structure'>): TemplateSlot[] {
  const layers = [...version.structure.layers].filter(l => l.role !== 'effect').sort((a, b) => a.order - b.order);
  const count = (role: TemplateRole) => layers.filter(l => l.role === role).length;
  const seen = new Map<TemplateRole, number>();
  const parentOf = (l: TemplateLayer) => l.attachment ? layers.find(p => p.id === l.attachment!.parent) : undefined;
  return layers.map(layer => {
    const n = (seen.get(layer.role) ?? 0) + 1; seen.set(layer.role, n);
    const many = count(layer.role) > 1, where = layer.zone && layer.zone !== 'full-canvas' ? ZONE_SHORT[layer.zone] : undefined;
    const label = `${TEMPLATE_ROLE_LABELS[layer.role]}${many ? ` · ${where ?? n}` : ''}`;
    const parent = parentOf(layer), kind = KIND[layer.role];
    const group: SlotGroup = layer.role === 'main_product' && layers.some(l => l.role === 'main_product' && l.order < layer.order) ? 'advanced' : GROUP[layer.role] ?? 'advanced';
    return { id: layer.id, role: layer.role, kind, group, label, ...(layer.zone ? { zone: layer.zone } : {}), placeholder: EXAMPLES[layer.role] ?? 'Leave empty to keep the original',
      hint: HINTS[kind], ...(parent && !layer.independent ? { groupedWith: TEMPLATE_ROLE_LABELS[parent.role].toLowerCase() } : {}) };
  });
}

export interface TemplateEditOptions {
  /** How a filled Main product field changes the product. replace (default): a different product; details: the same product, changed. */
  mainProduct?: { mode?: 'replace' | 'details'; brand?: string; keepSupporting?: boolean };
  /** A product reference image is attached as the second input image. */
  productReference?: boolean;
  /**
   * Without an image analysis: what happens to a text or logo field left empty when the main product is replaced (it may
   * name the old product). Every such field needs one before generating; nothing is kept or removed by guess.
   */
  textDecisions?: Record<string, 'keep' | 'remove'>;
}
/** A decision generating needs first (without an image analysis): one empty text or logo field when the product changes. */
export interface TemplateEditQuestion { slotId: string; label: string; message: string }
/** The text and logo roles that can name a product (a button's text rarely does). */
const PRODUCT_TEXT_ROLES: readonly TemplateRole[] = ['logo', 'headline', 'price', 'body_text', 'badge'];
export type EditOperation = 'replace' | 'details' | 'restyle' | 'text' | 'remove';
export interface EditChange { slotId: string; label: string; role: TemplateRole; operation: EditOperation; value?: string; sentence: string; structural: boolean }
/** A piece of the prompt: a locked rule, or text that comes from a field (slotId) — the parts the UI highlights. */
export interface PromptSegment { kind: 'fixed' | 'slot'; text: string; slotId?: string; label?: string }
/** Whether the template's saved decomposition plan still describes the creative after these changes. */
export interface BlueprintCompatibility { status: 'compatible' | 'structural-change'; reasons: string[]; changedSlots: string[] }
export interface CompiledTemplateEdit {
  text: string; segments: PromptSegment[]; changes: EditChange[];
  /** Decisions needed before generating (none: ready). The server refuses a request that leaves any open. */
  questions: TemplateEditQuestion[];
  /** One deterministic line naming every change: the execution's instruction (history and duplicate detection). */
  summary: string;
  compatibility: BlueprintCompatibility;
}
export const FIELD_LIMIT = 120, BRAND_LIMIT = 60;

const quote = (text: string) => `"${text}"`;
const where = (slot: TemplateSlot) => slot.zone ? ` ${ZONE_PHRASES[slot.zone]}` : '';
/** "the supporting product at the top left" (or "supporting product 2" when no position tells it apart). */
const phrase = (slot: TemplateSlot) => `${slot.zone && slot.zone !== 'full-canvas' ? TEMPLATE_ROLE_LABELS[slot.role].toLowerCase() : slot.label.toLowerCase().replace(' · ', ' ')}${where(slot)}`;
const PROTECTED_TEXT = 'Do not add any other new text, prices, discounts, product specifications, brand names or logos.';

/** Field values and options, checked: every key a field of this template, every value plain text within its limit. */
function cleanInput(slots: TemplateSlot[], values: unknown, options: TemplateEditOptions = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Use the selected template fields.');
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!slots.some(s => s.id === key) || typeof value !== 'string' || value.length > FIELD_LIMIT) throw new Error(`Each change must name a saved template field and contain at most ${FIELD_LIMIT} characters.`);
    const text = sanitizeEditInstruction(value);
    if (text) clean[key] = text;
  }
  const brand = sanitizeEditInstruction(options.mainProduct?.brand ?? '');
  if (brand.length > BRAND_LIMIT) throw new Error(`A brand is at most ${BRAND_LIMIT} characters.`);
  for (const [key, value] of Object.entries(options.textDecisions ?? {})) if (!slots.some(s => s.id === key) || (value !== 'keep' && value !== 'remove')) throw new Error('A text decision names a template text field and is keep or remove.');
  return { values: clean, brand };
}

/** The changes these values request, in back-to-front order, with the companions a replaced main product takes along. */
/** The brand of the new main product: the brand field, else the one brand the user's own words name (never a guess). */
export function mainProductBrand(value: string | undefined, brandField: string): { brand?: string; ambiguous?: string[] } {
  if (brandField) return { brand: brandField };
  const read = brandInWords(value);
  return !read ? {} : 'ambiguous' in read ? { ambiguous: read.ambiguous } : { brand: read.brand };
}
function changesOf(slots: TemplateSlot[], values: Record<string, string>, brandField: string, options: TemplateEditOptions, questions: TemplateEditQuestion[]): EditChange[] {
  const main = slots.find(s => s.role === 'main_product' && s.group === 'product'), mode = options.mainProduct?.mode ?? 'replace';
  const replacingMain = !!main && !!values[main.id] && mode === 'replace';
  const named = replacingMain ? mainProductBrand(values[main!.id], brandField) : {}, brand = named.brand ?? '';
  if (named.ambiguous) questions.push({ slotId: main!.id, label: main!.label, message: `Your words name more than one brand (${named.ambiguous.join(' and ')}). Give one in the Brand field.` });
  const changes: EditChange[] = [];
  for (const slot of slots) {
    const value = values[slot.id], base = { slotId: slot.id, label: slot.label, role: slot.role };
    if (!value) {
      // The original product set goes with a replaced main product unless the user keeps or changes its companions.
      if (replacingMain && slot.role === 'supporting_product' && !options.mainProduct?.keepSupporting) changes.push({ ...base, operation: 'remove', structural: true,
        sentence: `Remove the ${phrase(slot)}: it belongs to the original product set. Continue the background design where it was.` });
      // Text or a logo left as it is may name the old product: without an analysis that is the user's decision, never a guess.
      if (replacingMain && PRODUCT_TEXT_ROLES.includes(slot.role)) {
        const decided = options.textDecisions?.[slot.id];
        if (decided === 'remove') changes.push({ ...base, operation: 'remove', structural: true,
          sentence: `Remove the ${TEMPLATE_ROLE_LABELS[slot.role].toLowerCase()}${slot.role === 'logo' ? '' : ' text'}${where(slot)} completely and continue the background design where it was.` });
        else if (decided !== 'keep') questions.push({ slotId: slot.id, label: slot.label, message: `${slot.label} may name the old product. Keep it, remove it, or type its new text.` });
      }
      continue;
    }
    if (slot.kind === 'text') {
      changes.push({ ...base, operation: 'text', value, structural: false,
        sentence: `Replace the ${TEMPLATE_ROLE_LABELS[slot.role].toLowerCase()} text${where(slot)} with exactly ${quote(value)}, in the same style, size and place; spell it exactly as given.` });
    } else if (slot.kind === 'style') {
      changes.push({ ...base, operation: 'restyle', value, structural: false,
        sentence: `Restyle the ${TEMPLATE_ROLE_LABELS[slot.role].toLowerCase()}${where(slot)}: ${value}. Keep its place and shape in the layout.` });
    } else if (slot === main && mode === 'details') {
      changes.push({ ...base, operation: 'details', value, structural: false,
        sentence: `Change the main product${where(slot)}: ${value}. It stays the same product, in the same place, shape and pose.` });
    } else if (slot === main) {
      const product = brand && !namesWord(value, brand) ? `${brand} ${value}` : value;
      // One brand rule: the named brand is shown as the product carries it (and excepted from the no-brand rule below);
      // with none named, no brand is drawn at all.
      changes.push({ ...base, operation: 'replace', value: product, structural: true,
        sentence: `Replace the main product${where(slot)} with ${quote(product)}. Remove the original main product completely: no part of it may remain. The new product may have a different shape, size and silhouette; place it where the original stood, at a similar scale and visual weight, with matching lighting, reflections and shadow.${
          options.productReference ? ' Match the new product to the second attached image (the product reference), ignoring that image\'s background.' : brand ? ` Show the ${brand} brand only as this product would plainly carry it; do not invent model numbers or specifications.` : ' Show no brand name or logo on it; do not invent model numbers or specifications.'}` });
    } else if (slot.role === 'held_object') {
      changes.push({ ...base, operation: 'replace', value, structural: !slot.groupedWith,
        sentence: `Replace the held object${where(slot)} with ${quote(value)}. Remove the original completely; keep the grip natural.` });
    } else if (slot.role === 'primary_subject' || slot.role === 'secondary_subject') {
      // A different person or character keeps the role, place and scale: the saved plan still describes one subject there.
      changes.push({ ...base, operation: 'replace', value, structural: false,
        sentence: `Replace the ${TEMPLATE_ROLE_LABELS[slot.role].toLowerCase()}${where(slot)} with ${quote(value)}, in the same place, scale and facing direction.` });
    } else {
      changes.push({ ...base, operation: 'replace', value, structural: true,
        sentence: `Replace the ${phrase(slot)} with ${quote(value)}. Remove the original completely; the new object may have a different shape.` });
    }
  }
  return changes;
}

/** The locked rules around the changes: what the edit keeps, and what it may never add. */
function fixedRules(slots: TemplateSlot[], changes: EditChange[], brand = '') {
  const touched = new Set(changes.map(c => c.slotId));
  const kept = slots.filter(s => !touched.has(s.id) && s.role !== 'background');
  const keep = kept.length ? `Keep the rest of the layout exactly: ${kept.map(s => `the ${phrase(s)}`).join(', ')}.` : '';
  const objects = changes.some(c => c.operation === 'replace' || c.operation === 'remove');
  // A replaced main product: the visible text kept is only what was chosen to keep (it never silently outlives the product).
  const textKept = changes.some(c => c.role === 'main_product' && c.operation === 'replace') ? 'the visible text that is kept' : 'all visible text';
  const protectedText = brand ? `${PROTECTED_TEXT.slice(0, -1)}, except the ${brand} brand marking the new product itself plainly carries.` : PROTECTED_TEXT;
  return [keep,
    `Keep everything not changed above as it is: positions, sizes, poses, stacking order, lighting direction, colors, style and ${textKept}.`,
    objects ? 'Add or remove objects only as the changes above require; add nothing else.' : 'Do not add or remove elements.',
    changes.some(c => c.operation === 'text') ? `Use the new text exactly as given. ${protectedText}` : protectedText].filter(Boolean);
}

/** The prompt for these field values and options: the same text in the preview and in the request. */
export function compileTemplateEdit(version: Pick<TemplateVersion, 'structure'>, values: unknown, options: TemplateEditOptions = {}): CompiledTemplateEdit {
  const slots = describeTemplateSlots(version), input = cleanInput(slots, values, options), questions: TemplateEditQuestion[] = [], changes = changesOf(slots, input.values, input.brand, options, questions);
  const mainChange = changes.find(c => c.role === 'main_product' && c.operation === 'replace'), main = slots.find(s => s.role === 'main_product' && s.group === 'product');
  const shownBrand = mainChange && !options.productReference && main ? mainProductBrand(input.values[main.id], input.brand).brand ?? '' : '';
  const segments: PromptSegment[] = [{ kind: 'fixed', text: 'Edit the attached advertising creative.' }];
  if (changes.length) {
    segments.push({ kind: 'fixed', text: 'Make these changes:' });
    changes.forEach((c, i) => segments.push({ kind: 'slot', slotId: c.slotId, label: c.label, text: `(${i + 1}) ${c.sentence}` }));
  } else segments.push({ kind: 'fixed', text: GENERATE_UNCHANGED_INSTRUCTION });
  for (const rule of fixedRules(slots, changes, shownBrand)) segments.push({ kind: 'fixed', text: rule });
  const structural = changes.filter(c => c.structural);
  const compatibility: BlueprintCompatibility = structural.length
    ? { status: 'structural-change', changedSlots: structural.map(c => c.slotId), reasons: structural.map(c => c.operation === 'remove'
      ? `${c.label} is removed, so the saved plan's ${c.label.toLowerCase()} layer has nothing to extract.`
      : `${c.label} becomes ${quote(c.value!)}: a different object than the one the saved decomposition plan was learned from.`) }
    : { status: 'compatible', changedSlots: [], reasons: changes.length ? ['Only looks, text or subjects in their saved places change: the saved plan still describes this creative.'] : ['Nothing changes.'] };
  const summary = changes.length ? changes.map(c => `${c.label}: ${c.operation}${c.value ? ` ${c.value}` : ''}`).join('; ') : 'no changes';
  return { text: segments.map(s => s.text).join(' '), segments, changes, questions, summary, compatibility };
}

/** The template's base prompt: its locked rules, with every field shown where its change would go. */
export function baseTemplatePrompt(version: Pick<TemplateVersion, 'structure'>): PromptSegment[] {
  const slots = describeTemplateSlots(version);
  return [{ kind: 'fixed', text: 'Edit the attached advertising creative. Make these changes:' },
    ...slots.map((s): PromptSegment => ({ kind: 'slot', slotId: s.id, label: s.label, text: `{${s.label}}` })),
    ...fixedRules(slots, []).map((text): PromptSegment => ({ kind: 'fixed', text }))];
}
