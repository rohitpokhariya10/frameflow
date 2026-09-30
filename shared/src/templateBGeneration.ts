/**
 * Template B image generation (test/admin harness): product-focused advertising creatives.
 *
 * This module owns everything Template B means when a creative is generated: its fields, its validation, its fixed
 * prompt structure, the consistency and framing sentences of its aspect-ratio variants, and how its ratios are kept
 * together. Nothing here is shared with Template A (a framed portrait of a subject) or Template C (a human-centric
 * campaign layout), and nothing in the fixed wording names a specific product. The examples are examples, not rules.
 *
 * The user gives the creative intent in three plain inputs: the main product, the scene or visual style around it, and
 * optionally a few extra details. They do not sort anything into "intrinsic parts", "secondary objects", "support",
 * "lighting" or "composition". Template B knows what its family is and adds that itself, the same way every time:
 * one dominant hero, shown whole; the hero's own parts stay with it; whatever the scene puts around or under it is a
 * separate, distinguishable element; a designed background; professional advertising lighting and composition; a clean
 * hierarchy; no people, no extra hero, no clutter, no stray text. That structure is what keeps a generated creative
 * suitable for the Template B decomposition, and none of it depends on how much the user typed.
 *
 * Earlier versions of this profile asked for more: version 1 had fourteen detailed fields, version 2 five. Records made
 * with them stay as they are: listed, shown, generated and decomposed from what they stored. Only putting one back into
 * the form reads its fields through upgradeTemplateBFields.
 *
 * The shared mechanics (ratios, sizes, how a variant's prompt is assembled) are in templateGeneration.ts.
 */
import { joinBasePrompt, meansNone, resolveGenerationFields, saysSo, type GenerationField, type GenerationFieldValues, type GenerationProfile } from './templateGeneration.js';

export const TEMPLATE_B_GENERATION_VERSION = 'template-b-generation-v3';
export type TemplateBFieldKey = 'mainProduct' | 'sceneStyle' | 'extraDetails' | 'productAngle' | 'imageText';
export type TemplateBField = GenerationField & { key: TemplateBFieldKey };
export type TemplateBFieldValues = Record<TemplateBFieldKey, string>;

/** How the product is turned towards the viewer, and the words each choice adds. "auto" adds none: the model chooses. */
const PRODUCT_ANGLES = { auto: '', front: ', seen from the front', 'three-quarter': ', in a three-quarter view', side: ', seen from the side' } as const;
/**
 * The whole form: three creative inputs, and two small choices under "Advanced options" that most users never open.
 * The limits are chosen so that a completely filled form still fits the base prompt limit; a longer answer is refused
 * with a message, never cut.
 */
export const TEMPLATE_B_FIELDS: TemplateBField[] = [
  { key: 'mainProduct', label: 'Main product', default: '', required: true, maxLength: 120, help: 'What do you want this creative to feature?', placeholder: 'e.g. lavender premium smartphone',
    examples: ['Lavender smartphone', 'Ceramic table lamp', 'Roasted broccoli dish', 'Orange pendant light'] },
  { key: 'sceneStyle', label: 'Scene / visual style', default: '', required: true, maxLength: 500, multiline: true, help: 'Describe the look and setting you want around the product.', placeholder: 'e.g. premium pastel studio with soft lavender spheres',
    examples: ['Premium pastel studio with soft lavender spheres around the phone.', 'Bright lime-green advertising scene with a white geometric platform and a pink graphic shape.',
      'Warm cream poster background with orange geometric panels and thin grid lines.', 'Minimal cream editorial poster with orange graphic accents.'] },
  { key: 'extraDetails', label: 'Extra details', default: '', required: false, maxLength: 300, multiline: true, help: 'Anything specific you want the product or composition to show.', placeholder: 'e.g. show the back of the phone, no text',
    examples: ['Back of the phone facing the viewer', 'Show the full lamp', 'No text', 'Keep the food plate fully visible', 'Use a three-quarter product angle'] },
  { key: 'productAngle', advanced: true, label: 'Product angle', default: 'auto', required: false, maxLength: 20, help: 'How the product is turned towards the viewer. Auto lets Template B choose.',
    options: [{ value: 'auto', label: 'Auto' }, { value: 'front', label: 'Front' }, { value: 'three-quarter', label: 'Three-quarter' }, { value: 'side', label: 'Side' }] },
  { key: 'imageText', advanced: true, label: 'Text in the image', default: 'avoid', required: false, maxLength: 20, help: 'Generated lettering is often misspelt, so it is left out unless you allow it and describe it.',
    options: [{ value: 'avoid', label: 'Avoid text and logos' }, { value: 'allow', label: 'Allow text I describe' }] },
];
/** A field's label, for messages that point the user at it. */
const labelOf = (key: TemplateBFieldKey) => TEMPLATE_B_FIELDS.find(field => field.key === key)!.label;
export const TEMPLATE_B_DEFAULTS = Object.fromEntries(TEMPLATE_B_FIELDS.map(field => [field.key, field.default])) as TemplateBFieldValues;

/** The fixed skeleton, as shown read-only; [ ] marks wording that depends on a field or a choice, | alternatives. */
export const TEMPLATE_B_SKELETON = 'Create a premium product advertising image featuring one {mainProduct} as the single, clearly dominant hero. Scene and visual style: {sceneStyle}. [Requested details: {extraDetails}.] The hero\'s own parts, contents and markings stay with it; anything the scene places around or under it (objects, a platform, graphic shapes) is a separate element, complete and clearly distinguishable from the hero. Show the hero whole and intact, large in the frame[, {productAngle}]; unless described otherwise, use soft professional advertising lighting with gentle shadows and a balanced composition. Keep a clean commercial hierarchy: the hero, the elements around it and the designed background are visually distinct, with clean edges. Polished, sharp, high-resolution finish. No people or hands, no extra copies of the hero, no unrelated props, no clutter{, and no text or logos except what is on the hero itself. | . Show only the text the description asks for, short and legible.}';

/** A main product that names a person: Template B's hero is an object. "woman's handbag" and "model car" are objects; "young woman" is not. */
const HUMAN_HERO = /\b(?:man|woman|person|people|girl|boy|child|children|baby|lady|gentleman|couple)$/i;
/**
 * The field values for a Template B creative: the shared field mechanics, then Template B's own rule that the hero is a
 * non-human object.
 */
export function resolveTemplateBFields(input: unknown): { values: TemplateBFieldValues; errors: string[] } {
  const { values, errors } = resolveGenerationFields('Template B', TEMPLATE_B_FIELDS, input);
  if (HUMAN_HERO.test(values.mainProduct.trim())) errors.push(`${labelOf('mainProduct')} must be a product or object, not a person: Template B is built around one non-human hero.`);
  return { values: values as TemplateBFieldValues, errors };
}

/**
 * The hero as the prompt names it. Exactly one, unless the user asks for a number themselves: "lavender smartphone" and
 * "a lavender smartphone" are one lavender smartphone; "two ceramic lamps" or "a set of three bowls" is what it says.
 */
function heroPhrase(mainProduct: string): { phrase: string; single: boolean } {
  if (/^(?:two|three|four|five|six|several|a (?:pair|set|trio|row|stack) of|pair of|set of|\d+)\b/i.test(mainProduct)) return { phrase: mainProduct, single: false };
  return { phrase: `one ${mainProduct.replace(/^(?:an?|the|one|single)\s+/i, '')}`, single: true };
}

/**
 * The Template B base prompt: the user's intent first, then the fixed Template B structure, each rule said once. The
 * user does not label anything: what the hero is comes from the main product, and everything the scene adds around or
 * under it is declared a separate element here, which is what lets the decomposition tell them apart later.
 */
export function buildTemplateBGenerationPrompt(values: TemplateBFieldValues): string {
  const v = values, hero = heroPhrase(v.mainProduct), angle = PRODUCT_ANGLES[v.productAngle as keyof typeof PRODUCT_ANGLES] ?? '';
  return joinBasePrompt([
    `Create a premium product advertising image featuring ${hero.phrase} as the ${hero.single ? 'single, ' : ''}clearly dominant hero.`,
    `Scene and visual style: ${v.sceneStyle}.`,
    !meansNone(v.extraDetails) && `Requested details: ${v.extraDetails}.`,
    'The hero\'s own parts, contents and markings stay with it; anything the scene places around or under it (objects, a platform, graphic shapes) is a separate element, complete and clearly distinguishable from the hero.',
    // Defaults the user does not have to type; they give way to what the description says.
    `Show the hero whole and intact, large in the frame${angle}; unless described otherwise, use soft professional advertising lighting with gentle shadows and a balanced composition.`,
    'Keep a clean commercial hierarchy: the hero, the elements around it and the designed background are visually distinct, with clean edges.',
    `Polished, sharp, high-resolution finish. No people or hands, no extra copies of the hero, no unrelated props, no clutter${v.imageText === 'allow' ? '.' : ', and no text or logos except what is on the hero itself.'}`,
    v.imageText === 'allow' && 'Show only the text the description asks for, short and legible.',
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
/**
 * Added to the prompt of a ratio that is made from another ratio's image (see GenerationProfile.referenceInstruction):
 * the attached image is the creative; this frame is the same creative, reframed.
 */
export const TEMPLATE_B_REFERENCE_INSTRUCTION = 'The attached image is this same creative in another aspect ratio. Recreate it for this frame: the same product with the same design, colours and details, the same background and the same surrounding elements in the same style and arrangement. Change the framing only; do not stretch, redesign, add or remove anything.';

/** What is worth knowing about a Template B creative before it is generated or decomposed. Never blocking. */
export function templateBNotes(values: TemplateBFieldValues): string[] {
  const notes: string[] = [];
  if (/\b(?:transparent|translucent|clear|glass|crystal|reflective|mirror\w*|chrome|polished|glossy)\b/i.test(`${values.mainProduct} ${values.extraDetails}`)) notes.push('A transparent or reflective product is harder to separate cleanly from what shows through or reflects in it; expect the decomposition planner to warn about its edges.');
  if (saysSo(`${values.sceneStyle} ${values.extraDetails}`, /\b(?:touch\w*|overlap\w*|lean\w*|against|resting on|on top of)\b/i)) notes.push('Some objects touch or overlap the main product: when decomposing, "Separate touching / overlapping independent objects" decides whether they become their own layers or stay with the product.');
  if (values.imageText === 'allow') notes.push('Generated lettering is often misspelt: check it in each ratio. It is decomposed as picture, not as editable text.');
  return notes;
}

/**
 * The fields of a creative made with an earlier version of this form, as today's, so it can be put back into the form.
 * What described the setting and what stood around the product becomes the scene; what described the product itself,
 * how it was placed and the notes become the extra details. Fields already in today's form are returned as they are.
 * Nothing stored is changed.
 *
 * Version 1 (fourteen fields): heroProduct, heroDescription, material, intrinsicDetails, placement, support,
 * secondaryObjects, decoration, foregroundAccents, background, composition, lighting, palette, extraNotes.
 * Version 2 (five fields): heroProduct, productLook, scene, extras, extraInstructions.
 */
export function upgradeTemplateBFields(stored: GenerationFieldValues): GenerationFieldValues {
  if ('mainProduct' in stored || !('heroProduct' in stored)) return stored;
  const given = (key: string) => meansNone(stored[key]) ? '' : stored[key].trim(), join = (parts: string[]) => parts.filter(Boolean).join('; ');
  return {
    ...TEMPLATE_B_DEFAULTS,
    mainProduct: stored.heroProduct.trim(),
    sceneStyle: join([given('scene'), given('background'), given('lighting'), given('palette'), given('support') && `${given('support')} under the product`, given('secondaryObjects'), given('decoration'), given('foregroundAccents'), given('extras')]),
    extraDetails: join([given('productLook'), given('heroDescription'), given('material'), given('intrinsicDetails') && `including ${given('intrinsicDetails')}`, given('placement'), given('composition'), given('extraNotes'), given('extraInstructions')]),
  } satisfies TemplateBFieldValues;
}

/** Template B's generation profile: everything above, in the form the shared multi-ratio mechanics take. */
export const templateBGenerationProfile: GenerationProfile = {
  templateKey: 'template-b', name: 'Template B', version: TEMPLATE_B_GENERATION_VERSION,
  tagline: 'Product-focused advertising creative', intro: 'Describe one product creative. Template B handles the composition, lighting and decomposition-friendly structure for you.',
  family: 'One clearly dominant non-human hero (a product, object, dish, piece of furniture or gadget) on a designed background, optionally on a support, with optional surrounding independent objects and decorative elements; a clean hierarchy with no people and no clutter.',
  sameAcrossRatios: 'the product and its look, the background, and the objects and graphics around it',
  mayDiffer: 'the exact reflections and shadows, small surface details, the precise position of each surrounding object',
  skeleton: TEMPLATE_B_SKELETON, fields: TEMPLATE_B_FIELDS, defaults: TEMPLATE_B_DEFAULTS, consistency: TEMPLATE_B_CONSISTENCY, framing: TEMPLATE_B_RATIO_FRAMING,
  resolveFields: resolveTemplateBFields, buildBasePrompt: values => buildTemplateBGenerationPrompt(values as TemplateBFieldValues),
  notes: values => templateBNotes(values as TemplateBFieldValues), summarize: values => values.mainProduct ?? values.heroProduct ?? '',
  upgradeFields: upgradeTemplateBFields, referenceInstruction: TEMPLATE_B_REFERENCE_INSTRUCTION,
};
