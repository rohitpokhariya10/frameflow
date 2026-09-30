/**
 * Template B image generation (test/admin harness): single-hero product, editorial and staged compositions.
 *
 * This module owns everything Template B means when a creative is generated: its fields, its validation, its fixed
 * prompt structure, and the consistency and framing sentences of its aspect-ratio variants. Nothing here is shared with
 * Template A (a framed portrait of a subject) or Template C (a human-centric campaign layout), and nothing names a
 * specific product: the structure speaks of a hero, its intrinsic parts, a support, surrounding independent objects,
 * decoration and a background. The field defaults are examples, not rules.
 *
 * The structure keeps a generated creative easy to decompose with Template B: one dominant hero shown whole and once;
 * parts that belong to the hero stay with it; the support, the surrounding objects, the decoration and the background
 * are each distinguishable; no people, no duplicate hero, no clutter.
 *
 * The shared mechanics (ratios, sizes, how a variant's prompt is assembled) are in templateGeneration.ts.
 */
import { joinBasePrompt, meansNone, resolveGenerationFields, saysSo, withArticle, type GenerationField, type GenerationProfile } from './templateGeneration.js';

export const TEMPLATE_B_GENERATION_VERSION = 'template-b-generation-v1';
export type TemplateBFieldKey = 'heroProduct' | 'heroDescription' | 'material' | 'intrinsicDetails' | 'placement' | 'support' | 'secondaryObjects' | 'decoration' | 'foregroundAccents' | 'background'
  | 'composition' | 'lighting' | 'palette' | 'extraNotes';
export type TemplateBField = GenerationField & { key: TemplateBFieldKey };
export type TemplateBFieldValues = Record<TemplateBFieldKey, string>;

/** Required fields carry Template B's structure; every other field is optional and drops its wording when empty. */
export const TEMPLATE_B_FIELDS: TemplateBField[] = [
  { key: 'heroProduct', label: 'Hero product / object', default: 'ceramic table lamp', required: true, maxLength: 120, help: 'One non-human product, object, dish, piece of furniture or gadget.' },
  { key: 'heroDescription', label: 'Hero description', default: 'matte cream body with a linen shade and a brass switch', required: true, maxLength: 200, help: 'Its look: shape, colours, visible details.' },
  { key: 'material', label: 'Material / finish', default: '', required: false, maxLength: 120, help: 'E.g. brushed metal, clear glass, glossy glaze.' },
  { key: 'intrinsicDetails', label: 'Intrinsic product details', default: '', required: false, maxLength: 200, help: 'Parts, contents or printed marks that belong to the product itself and stay with it.' },
  { key: 'placement', label: 'Product orientation / placement', default: 'upright, centred, three-quarter view', required: false, maxLength: 160, help: '' },
  { key: 'support', label: 'Support / pedestal / platform', default: 'low round stone pedestal', required: false, maxLength: 160, help: 'Empty or "none" = the hero stands on its own.' },
  { key: 'secondaryObjects', label: 'Secondary independent objects', default: '', required: false, maxLength: 200, help: 'Separate objects around the hero: say how many, and whether any touch it. Empty = none.' },
  { key: 'decoration', label: 'Decorative elements / graphics', default: 'two soft arch shapes behind the product', required: false, maxLength: 200, help: 'Shapes, panels, patterns. Empty = none.' },
  { key: 'foregroundAccents', label: 'Foreground accents', default: '', required: false, maxLength: 160, help: 'Small accents in front of the scene.' },
  { key: 'background', label: 'Background / environment', default: 'soft warm-beige studio backdrop with a gentle gradient', required: true, maxLength: 200, help: 'The designed backdrop behind everything.' },
  { key: 'composition', label: 'Composition', default: '', required: false, maxLength: 160, help: 'A preference, e.g. hero slightly left with open space on the right.' },
  { key: 'lighting', label: 'Lighting', default: 'soft diffused studio light with a gentle shadow', required: false, maxLength: 160, help: '' },
  { key: 'palette', label: 'Colour palette', default: 'warm neutrals with one muted terracotta accent', required: false, maxLength: 160, help: '' },
  { key: 'extraNotes', label: 'Extra notes', default: '', required: false, maxLength: 300, help: 'A little extra visual guidance; it cannot replace the Template B structure.' },
];
export const TEMPLATE_B_DEFAULTS = Object.fromEntries(TEMPLATE_B_FIELDS.map(field => [field.key, field.default])) as TemplateBFieldValues;

/** The fixed skeleton, as shown read-only; [ ] marks wording dropped when its field is empty, | alternatives. */
export const TEMPLATE_B_SKELETON = 'Create a clean, editorial product advertising image with one {heroProduct} as the single, clearly dominant hero object: {heroDescription}[, {material}]. [The hero includes {intrinsicDetails}; these are part of the hero and stay with it.] [The hero is shown {placement}.] {The hero rests on {support}, a separate element that is clearly distinguishable from the hero. | The hero stands on its own, with no separate platform or pedestal.} {Around the hero: {secondaryObjects}. Each of these is a separate, complete object, clearly distinguishable from the hero. | No other objects accompany the hero.} [Decorative elements: {decoration}, kept as graphic elements of their own behind or beside the hero.] [Foreground accents: {foregroundAccents}.] Background: {background}, a designed backdrop clearly separate from everything in front of it. [Composition: {composition}.] [Lighting: {lighting}.] [Colour palette: {palette}.] Show the hero whole and intact, exactly once. Keep a clean visual hierarchy, with clear separation between the hero[, its support][, the other objects][, the decorative elements] and the background. Realistic, sharp, high-resolution product photography. No people and no hands, no second copy of the hero, no unrelated props, no clutter, and no text or logos except what is part of the hero itself. [Additional notes: {extraNotes}.]';

export const hasSupport = (values: Pick<TemplateBFieldValues, 'support'>) => !meansNone(values.support);
export const hasSecondaryObjects = (values: Pick<TemplateBFieldValues, 'secondaryObjects'>) => !meansNone(values.secondaryObjects);
export const hasDecoration = (values: Pick<TemplateBFieldValues, 'decoration'>) => !meansNone(values.decoration);

/** A hero that names a person: Template B's hero is an object. "woman's handbag" and "model car" are objects; "young woman" is not. */
const HUMAN_HERO = /\b(?:man|woman|person|people|girl|boy|child|children|baby|lady|gentleman|couple)$/i;
/**
 * The field values for a Template B creative: the shared field mechanics, then Template B's own rule that the hero is a
 * non-human object.
 */
export function resolveTemplateBFields(input: unknown): { values: TemplateBFieldValues; errors: string[] } {
  const { values, errors } = resolveGenerationFields('Template B', TEMPLATE_B_FIELDS, input);
  if (HUMAN_HERO.test(values.heroProduct.trim())) errors.push('Hero product / object must be a product or object, not a person: Template B is built around one non-human hero.');
  return { values: values as TemplateBFieldValues, errors };
}

/** The Template B base prompt: the fixed skeleton filled from the fields, empty optional parts dropped. */
export function buildTemplateBGenerationPrompt(values: TemplateBFieldValues): string {
  const v = values, support = hasSupport(v), others = hasSecondaryObjects(v), decoration = hasDecoration(v);
  return joinBasePrompt([
    `Create a clean, editorial product advertising image with one ${v.heroProduct} as the single, clearly dominant hero object: ${v.heroDescription}${v.material ? `, ${v.material}` : ''}.`,
    v.intrinsicDetails && `The hero includes ${v.intrinsicDetails}; these are part of the hero and stay with it.`,
    v.placement && `The hero is shown ${v.placement}.`,
    support ? `The hero rests on ${withArticle(v.support)}, a separate element that is clearly distinguishable from the hero.` : 'The hero stands on its own, with no separate platform or pedestal.',
    others ? `Around the hero: ${v.secondaryObjects}. Each of these is a separate, complete object, clearly distinguishable from the hero.` : 'No other objects accompany the hero.',
    decoration && `Decorative elements: ${v.decoration}, kept as graphic elements of their own behind or beside the hero.`,
    v.foregroundAccents && `Foreground accents: ${v.foregroundAccents}.`,
    `Background: ${v.background}, a designed backdrop clearly separate from everything in front of it.`,
    v.composition && `Composition: ${v.composition}.`,
    v.lighting && `Lighting: ${v.lighting}.`,
    v.palette && `Colour palette: ${v.palette}.`,
    'Show the hero whole and intact, exactly once.',
    `Keep a clean visual hierarchy, with clear separation between the hero${support ? ', its support' : ''}${others ? ', the other objects' : ''}${decoration ? ', the decorative elements' : ''} and the background.`,
    'Realistic, sharp, high-resolution product photography. No people and no hands, no second copy of the hero, no unrelated props, no clutter, and no text or logos except what is part of the hero itself.',
    v.extraNotes && `Additional notes: ${v.extraNotes}.`,
  ]);
}

/**
 * Added to every variant, word for word: what stays the same across the aspect ratios of a Template B creative. It names
 * the optional parts only "where any are described", so it never asks for a support or objects the creative does not have.
 */
export const TEMPLATE_B_CONSISTENCY = 'This image is one of several aspect-ratio versions of the same product creative. Everything described above is the same in every version: the same hero with the same material, colours and details, the same background, and the same support, surrounding objects and decorative elements where any are described. Only the framing changes with the aspect ratio; do not add, remove or redesign anything.';
/** How a Template B creative is framed in each aspect ratio. Fixed text, never edited; the only difference between its variants. */
export const TEMPLATE_B_RATIO_FRAMING: GenerationProfile['framing'] = {
  '1:1': 'Framing for this version: 1:1, square. A balanced square composition: the hero centred and large, with an even amount of the background around the arrangement.',
  '16:9': 'Framing for this version: 16:9, wide. The same product creative in a wide frame: the hero keeps its size relative to the frame height, whatever surrounds it stays in its place around it, and the extra width is more of the same background, left calm.',
  '4:5': 'Framing for this version: 4:5, tall feed. The same product creative in a slightly tall frame: the hero centred and filling most of the frame width, with whatever surrounds it kept in its place around it.',
};

/** What is worth knowing about a Template B creative before it is generated or decomposed. Never blocking. */
export function templateBNotes(values: TemplateBFieldValues): string[] {
  const notes: string[] = [], look = `${values.heroDescription} ${values.material}`;
  if (/\b(?:transparent|translucent|clear|glass|crystal|reflective|mirror\w*|chrome|polished|glossy)\b/i.test(look)) notes.push('A transparent or reflective hero is harder to separate cleanly from what shows through or reflects in it; expect the decomposition planner to warn about its edges.');
  if (hasSecondaryObjects(values)) notes.push(saysSo(values.secondaryObjects, /\b(?:touch\w*|overlap\w*|lean\w*|against|resting on|on top of)\b/i)
    ? 'Some surrounding objects touch or overlap the hero: when decomposing, "Separate touching / overlapping independent objects" decides whether they become their own layers or stay with the hero.'
    : 'Say in "Secondary independent objects" whether any of them touches the hero: objects that touch it are handled by the decomposition option "Separate touching / overlapping independent objects".');
  if (!hasSupport(values)) notes.push('No platform: the hero stands on its own, so the decomposition has no support layer to find.');
  return notes;
}

/** Template B's generation profile: everything above, in the form the shared multi-ratio mechanics take. */
export const templateBGenerationProfile: GenerationProfile = {
  templateKey: 'template-b', name: 'Template B', version: TEMPLATE_B_GENERATION_VERSION,
  family: 'One clearly dominant non-human hero (a product, object, dish, piece of furniture or gadget) on a designed background, optionally on a support, with optional surrounding independent objects and decorative elements; a clean hierarchy with no people and no clutter.',
  sameAcrossRatios: 'the hero and its material, colours and details, the support, the surrounding objects, the decorative elements and the background',
  mayDiffer: 'the exact reflections and shadows, small surface details, the precise position of each surrounding object',
  skeleton: TEMPLATE_B_SKELETON, fields: TEMPLATE_B_FIELDS, defaults: TEMPLATE_B_DEFAULTS, consistency: TEMPLATE_B_CONSISTENCY, framing: TEMPLATE_B_RATIO_FRAMING,
  resolveFields: resolveTemplateBFields, buildBasePrompt: values => buildTemplateBGenerationPrompt(values as TemplateBFieldValues),
  notes: values => templateBNotes(values as TemplateBFieldValues), summarize: values => values.heroProduct,
};
