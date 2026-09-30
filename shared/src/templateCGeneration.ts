/**
 * Template C image generation (test/admin harness): human-centric promotional, editorial and campaign compositions.
 *
 * This module owns everything Template C means when a creative is generated: its fields, its validation, its fixed
 * prompt structure, and the consistency and framing sentences of its aspect-ratio variants. Nothing here is shared with
 * Template A (one subject in a framed portrait) or Template B (one non-human hero product), and nothing names a specific
 * campaign or product: the structure speaks of people, their grouping, repeated panels, a product showcase, a
 * promotional module, a badge, a headline, decorative structures and a background. The field defaults are examples.
 *
 * Template C is more than "several people": it is a designed, modular layout. The structure keeps a generated creative
 * easy to decompose with Template C: people whole, with what they wear; showcases, promotional modules and badges as
 * independent regions; repeated panels as one coherent set; background graphics distinguishable; no uncontrolled crowd.
 *
 * The shared mechanics (ratios, sizes, how a variant's prompt is assembled) are in templateGeneration.ts.
 */
import { joinBasePrompt, meansNone, resolveGenerationFields, saysSo, type GenerationField, type GenerationProfile } from './templateGeneration.js';

export const TEMPLATE_C_GENERATION_VERSION = 'template-c-generation-v1';
export type TemplateCFieldKey = 'concept' | 'primarySubjects' | 'additionalSubjects' | 'relationships' | 'repeatedPanels' | 'productShowcase' | 'promoModule' | 'logoBadge' | 'headline'
  | 'decorativeStructures' | 'background' | 'palette' | 'composition' | 'lightingStyle' | 'extraNotes';
export type TemplateCField = GenerationField & { key: TemplateCFieldKey };
export type TemplateCFieldValues = Record<TemplateCFieldKey, string>;

/** Required fields carry Template C's structure; every other field is optional and drops its wording when empty. */
export const TEMPLATE_C_FIELDS: TemplateCField[] = [
  { key: 'concept', label: 'Campaign / creative concept', default: 'seasonal sale campaign for a clothing brand', required: true, maxLength: 160, help: 'What the creative is for.' },
  { key: 'primarySubjects', label: 'Primary subject(s)', default: 'two people standing side by side, a woman in a yellow jacket and a man in a denim shirt', required: true, maxLength: 240, help: 'The people, or the human subject of each module. Say how many.' },
  { key: 'additionalSubjects', label: 'Additional human subjects', default: '', required: false, maxLength: 200, help: 'Further people, if any. Say how many.' },
  { key: 'relationships', label: 'Relationships / grouping between people', default: 'standing apart with a clear gap between them', required: false, maxLength: 200, help: 'Who overlaps or is posed together as a pair or group, and who stands apart.' },
  { key: 'repeatedPanels', label: 'Repeated panels / modules', default: '', required: false, maxLength: 200, help: 'Panels of one kind repeated in the layout: say how many and what each shows. Empty = none.' },
  { key: 'productShowcase', label: 'Product showcase', default: '', required: false, maxLength: 200, help: 'A product displayed on its own, not worn or held by a person. Empty = none.' },
  { key: 'promoModule', label: 'Promo card / module', default: 'a rounded offer card in the lower right corner', required: false, maxLength: 200, help: 'A promotional card or panel as its own region. Empty = none.' },
  { key: 'logoBadge', label: 'Logo / badge', default: 'a small round badge in the top left corner', required: false, maxLength: 160, help: 'Empty = none.' },
  { key: 'headline', label: 'Headline text', default: '', required: false, maxLength: 80, help: 'A few words to show as the headline. Empty = no headline.' },
  { key: 'decorativeStructures', label: 'Decorative structures', default: '', required: false, maxLength: 200, help: 'Arches, frames, borders, ribbons, scattered shapes. Empty = none.' },
  { key: 'background', label: 'Background / campaign environment', default: 'bold coral backdrop with large graphic sun rays', required: true, maxLength: 200, help: 'The designed background behind everything.' },
  { key: 'palette', label: 'Colour palette', default: '', required: false, maxLength: 160, help: '' },
  { key: 'composition', label: 'Composition', default: '', required: false, maxLength: 160, help: 'A preference for how the people and modules are arranged.' },
  { key: 'lightingStyle', label: 'Lighting / style', default: '', required: false, maxLength: 160, help: '' },
  { key: 'extraNotes', label: 'Extra notes', default: '', required: false, maxLength: 300, help: 'A little extra visual guidance; it cannot replace the Template C structure.' },
];
export const TEMPLATE_C_DEFAULTS = Object.fromEntries(TEMPLATE_C_FIELDS.map(field => [field.key, field.default])) as TemplateCFieldValues;

/** The fixed skeleton, as shown read-only; [ ] marks wording dropped when its field is empty, | alternatives. */
export const TEMPLATE_C_SKELETON = 'Create a designed promotional campaign creative. Concept: {concept}. It is a composed layout with a clear modular hierarchy, not a candid photograph. The people: {primarySubjects}[, together with {additionalSubjects}]. [Grouping: {relationships}.] Every person is shown whole and intact, and everything a person wears, or holds as part of the pose, stays with that person. {The layout includes {repeatedPanels}; the panels are of one kind and one size and form one coherent repeated set. | The layout has no repeated panels.} [A product showcase, {productShowcase}, is displayed on its own as an independent element, separate from anything worn or held by a person.] [A promotional module, {promoModule}, is an independent region of the layout, with everything inside it kept together.] [A logo or badge, {logoBadge}, stands as an element of its own.] {A headline reading "{headline}" stands on its own in large, clear lettering. | No headline text.} [Decorative structures: {decorativeStructures}, as graphic elements distinguishable from the people and the modules.] Background: {background}, clearly separate from the people and the modules in front of it. [Colour palette: {palette}.] [Composition: {composition}.] [Lighting and style: {lightingStyle}.] Keep the people, the modules and the background graphics visually distinct from each other, with clean edges. Only the people described appear: no crowd, no bystanders, no unrelated objects, no clutter. [Additional notes: {extraNotes}.]';

const has = (value: string) => !meansNone(value);
export const hasRepeatedPanels = (values: Pick<TemplateCFieldValues, 'repeatedPanels'>) => has(values.repeatedPanels);
/** The independent modules a creative names: a product showcase, a promotional module, repeated panels. */
export const templateCModules = (values: Pick<TemplateCFieldValues, 'repeatedPanels' | 'productShowcase' | 'promoModule'>) =>
  [has(values.repeatedPanels) && 'repeated panels', has(values.productShowcase) && 'product showcase', has(values.promoModule) && 'promo module'].filter((item): item is string => !!item);

/** The field values for a Template C creative: the shared field mechanics; a headline is kept free of quotation marks, which the prompt adds. */
export function resolveTemplateCFields(input: unknown): { values: TemplateCFieldValues; errors: string[] } {
  const { values, errors } = resolveGenerationFields('Template C', TEMPLATE_C_FIELDS, input);
  values.headline = values.headline.replace(/["“”]/g, '').trim();
  return { values: values as TemplateCFieldValues, errors };
}

/** The Template C base prompt: the fixed skeleton filled from the fields, empty optional parts dropped. */
export function buildTemplateCGenerationPrompt(values: TemplateCFieldValues): string {
  const v = values;
  return joinBasePrompt([
    `Create a designed promotional campaign creative. Concept: ${v.concept}. It is a composed layout with a clear modular hierarchy, not a candid photograph.`,
    `The people: ${v.primarySubjects}${has(v.additionalSubjects) ? `, together with ${v.additionalSubjects}` : ''}.`,
    has(v.relationships) && `Grouping: ${v.relationships}.`,
    'Every person is shown whole and intact, and everything a person wears, or holds as part of the pose, stays with that person.',
    has(v.repeatedPanels) ? `The layout includes ${v.repeatedPanels}; the panels are of one kind and one size and form one coherent repeated set.` : 'The layout has no repeated panels.',
    has(v.productShowcase) && `A product showcase, ${v.productShowcase}, is displayed on its own as an independent element, separate from anything worn or held by a person.`,
    has(v.promoModule) && `A promotional module, ${v.promoModule}, is an independent region of the layout, with everything inside it kept together.`,
    has(v.logoBadge) && `A logo or badge, ${v.logoBadge}, stands as an element of its own.`,
    has(v.headline) ? `A headline reading "${v.headline}" stands on its own in large, clear lettering.` : 'No headline text.',
    has(v.decorativeStructures) && `Decorative structures: ${v.decorativeStructures}, as graphic elements distinguishable from the people and the modules.`,
    `Background: ${v.background}, clearly separate from the people and the modules in front of it.`,
    v.palette && `Colour palette: ${v.palette}.`,
    v.composition && `Composition: ${v.composition}.`,
    v.lightingStyle && `Lighting and style: ${v.lightingStyle}.`,
    'Keep the people, the modules and the background graphics visually distinct from each other, with clean edges.',
    'Only the people described appear: no crowd, no bystanders, no unrelated objects, no clutter.',
    v.extraNotes && `Additional notes: ${v.extraNotes}.`,
  ]);
}

/**
 * Added to every variant, word for word: what stays the same across the aspect ratios of a Template C creative. It names
 * the optional modules only "where any are described", so it never asks for a panel or headline the creative does not have.
 */
export const TEMPLATE_C_CONSISTENCY = 'This image is one of several aspect-ratio versions of the same campaign creative. Everything described above is the same in every version: the same people with the same look and the same grouping, the same background theme and colours, and the same number of panels, the same product showcase, promotional module, badge and headline where any are described. Only the framing changes with the aspect ratio; do not add, remove or redesign any person or module.';
/** How a Template C creative is reflowed for each aspect ratio. Fixed text, never edited; the only difference between its variants. */
export const TEMPLATE_C_RATIO_FRAMING: GenerationProfile['framing'] = {
  '1:1': 'Framing for this version: 1:1, square. A balanced square layout: the people as the focus, with any modules arranged around them inside the frame.',
  '16:9': 'Framing for this version: 16:9, wide. The same campaign creative reflowed for a wide frame: the same people and any modules placed side by side across the width, none added and none removed, with the background theme filling the remaining space.',
  '4:5': 'Framing for this version: 4:5, tall feed. The same campaign creative reflowed for a slightly tall frame: the people in the upper and middle part, any modules placed below and beside them, none added and none removed.',
};

const SEVERAL_PEOPLE = /\b(?:two|three|four|five|six|seven|eight|\d+|both|pair|couple|group|trio|duo|people|persons|performers|models|friends|players|dancers|and)\b/i;
/** What is worth knowing about a Template C creative before it is generated or decomposed. Never blocking. */
export function templateCNotes(values: TemplateCFieldValues): string[] {
  const notes: string[] = [], severalPeople = SEVERAL_PEOPLE.test(values.primarySubjects) || has(values.additionalSubjects), modules = templateCModules(values);
  if (!severalPeople && !modules.length) notes.push('Template C is more than a single portrait: describe several people, or add a product showcase, a promo module or repeated panels. One person in a frame is Template A.');
  if (severalPeople) notes.push(saysSo(values.relationships, /\b(?:overlap\w*|embrac\w*|hug\w*|arm in arm|arms around|holding hands|leaning on|paired|posed together|back to back|close together)\b/i)
    ? 'People who overlap or are posed together: when decomposing, "Separate individual people / human subjects" decides whether each becomes a layer of their own or the group stays together.'
    : 'Several people: say in "Relationships / grouping" who overlaps or is posed together; the decomposition option "Separate individual people / human subjects" then decides how they are separated.');
  if (hasRepeatedPanels(values)) notes.push('Repeated panels: when decomposing, "Separate repeated subject / showcase panels" decides whether each panel is its own layer or the set stays together.');
  if (has(values.headline)) notes.push('Generated lettering is often misspelt: check the headline in each ratio. It is decomposed as picture, not as editable text.');
  return notes;
}

/** Template C's generation profile: everything above, in the form the shared multi-ratio mechanics take. */
export const templateCGenerationProfile: GenerationProfile = {
  templateKey: 'template-c', name: 'Template C', version: TEMPLATE_C_GENERATION_VERSION,
  family: 'A designed, human-centric campaign layout that is more than a single portrait: several people, or a person with an independent product showcase or promotional module, or repeated panels; with optional badge, headline and decorative structures, and no uncontrolled crowd.',
  sameAcrossRatios: 'the people and their grouping, the number of panels and modules, the product showcase, promotional module, badge and headline, and the background theme and colours',
  mayDiffer: 'the exact faces and poses, what is drawn inside a module, the precise arrangement of the modules',
  skeleton: TEMPLATE_C_SKELETON, fields: TEMPLATE_C_FIELDS, defaults: TEMPLATE_C_DEFAULTS, consistency: TEMPLATE_C_CONSISTENCY, framing: TEMPLATE_C_RATIO_FRAMING,
  resolveFields: resolveTemplateCFields, buildBasePrompt: values => buildTemplateCGenerationPrompt(values as TemplateCFieldValues),
  notes: values => templateCNotes(values as TemplateCFieldValues), summarize: values => values.concept,
};
