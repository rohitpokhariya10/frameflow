/**
 * The structural vocabulary of creative templates. A template is learned from one creative and reused for others, so
 * everything it keeps says what an element DOES in the composition (primary_subject, held_object, background), never
 * what it SHOWS ("baby girl", "iPhone"). What one image shows stays in that image's own run and execution history.
 */

/** Structural roles. A role names a job in the layout; the same role fits a baby with a phone and a man with a football. */
export const TEMPLATE_ROLES = ['background', 'backdrop', 'primary_subject', 'secondary_subject', 'held_object', 'main_product', 'supporting_product', 'prop',
  'headline', 'body_text', 'price', 'cta', 'badge', 'logo', 'decoration', 'effect'] as const;
export type TemplateRole = typeof TEMPLATE_ROLES[number];
export const isTemplateRole = (value: unknown): value is TemplateRole => (TEMPLATE_ROLES as readonly unknown[]).includes(value);

/** How each role is named to the user and to the decomposition model: generic words only. */
export const TEMPLATE_ROLE_LABELS: Record<TemplateRole, string> = {
  background: 'Background', backdrop: 'Backdrop or frame', primary_subject: 'Primary subject', secondary_subject: 'Secondary subject', held_object: 'Held object',
  main_product: 'Main product', supporting_product: 'Supporting product', prop: 'Prop or support', headline: 'Headline', body_text: 'Body text', price: 'Price or offer',
  cta: 'Call to action', badge: 'Badge', logo: 'Logo', decoration: 'Decorations', effect: 'Shadow or effect',
};
/** What a layer of each role contains, as the decomposition model is told: a description that fits every creative of a template. */
export const TEMPLATE_ROLE_DESCRIPTIONS: Record<TemplateRole, string> = {
  background: 'the full scene or surface behind every other element',
  backdrop: 'the panel, frame or decorative backdrop behind the main subject',
  primary_subject: 'the main person or character, whole, including hair, clothing and anything worn',
  secondary_subject: 'another person or character, whole, including anything worn',
  held_object: 'the object held in the subject\'s hand',
  main_product: 'the main advertised product, whole',
  supporting_product: 'a smaller product shown with the main one',
  prop: 'a supporting object such as a pedestal, stand or surface',
  headline: 'the main headline text, with its own effects',
  body_text: 'supporting body or caption text, with its own effects',
  price: 'price or offer text and its marks',
  cta: 'the call-to-action button with its label',
  badge: 'a badge, sticker or seal with its text',
  logo: 'the brand logo or wordmark',
  decoration: 'decorative graphics, grouped',
  effect: 'a shadow, glow or reflection that belongs to its parent',
};

/** Coarse zones of the canvas: where a role sits, without any pixel detail of one image. */
export const TEMPLATE_ZONES = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right', 'full-canvas'] as const;
export type TemplateZone = typeof TEMPLATE_ZONES[number];
/** Relations between roles that matter for decomposing them (held objects stay with a hand, things in front occlude). */
export const TEMPLATE_RELATIONS = ['holds', 'wears', 'in_front_of', 'behind', 'on', 'inside', 'attached_to', 'next_to', 'above', 'below', 'related_to'] as const;
export type TemplateRelation = typeof TEMPLATE_RELATIONS[number];
/** A free-text relationship word of a planner, as one of the template relations. */
export function templateRelation(value: string): TemplateRelation {
  const word = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (/hold|grip|carr/.test(word)) return 'holds';
  if (/wear|worn/.test(word)) return 'wears';
  if (/front|over|occlud|cover/.test(word)) return 'in_front_of';
  if (/behind|under(?!neath_text)|beneath/.test(word)) return 'behind';
  if (/inside|within|contain/.test(word)) return 'inside';
  if (/attach|part_of|connected/.test(word)) return 'attached_to';
  if (/(^|_)on(_|$)|rests|stands|sits/.test(word)) return 'on';
  if (/next|beside|near|adjacent/.test(word)) return 'next_to';
  if (/above|top/.test(word)) return 'above';
  if (/below|bottom/.test(word)) return 'below';
  return 'related_to';
}

/** Words that describe structure or language, never what an image shows: they may appear in reusable text. */
const STRUCTURAL_WORDS = new Set([
  ...TEMPLATE_ROLES.flatMap(role => role.split('_')), ...Object.values(TEMPLATE_ROLE_LABELS).flatMap(label => label.toLowerCase().split(/\W+/)),
  ...Object.values(TEMPLATE_ROLE_DESCRIPTIONS).flatMap(description => description.toLowerCase().split(/\W+/)),
  ...TEMPLATE_ZONES.flatMap(zone => zone.split('-')), ...TEMPLATE_RELATIONS.flatMap(relation => relation.split('_')),
  'the', 'and', 'with', 'for', 'from', 'into', 'onto', 'over', 'under', 'its', 'their', 'this', 'that', 'these', 'those', 'one', 'two', 'three', 'each', 'every', 'any', 'all',
  'layer', 'layers', 'layout', 'composition', 'structure', 'template', 'creative', 'image', 'scene', 'element', 'elements', 'subject', 'subjects', 'object', 'objects',
  'product', 'products', 'person', 'people', 'character', 'text', 'button', 'frame', 'panel', 'graphic', 'graphics', 'shape', 'shapes', 'holding', 'held', 'hand', 'hands',
  'main', 'primary', 'secondary', 'supporting', 'single', 'centered', 'centred', 'framed', 'left', 'right', 'top', 'bottom', 'middle', 'center', 'centre', 'full', 'canvas',
  'front', 'behind', 'background', 'foreground', 'decorative', 'offer', 'promotion', 'promotional', 'hero', 'portrait', 'poster', 'banner', 'call', 'action',
]);
const tokens = (text: string) => text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? [];
/**
 * The content words of one image: what its planner said its elements are ("baby", "girl", "iphone", "cream"), minus
 * structural words. Reusable text must contain none of them.
 */
export function contentWords(descriptions: readonly string[]): Set<string> {
  return new Set(descriptions.flatMap(tokens).filter(word => word.length >= 3 && !STRUCTURAL_WORDS.has(word) && !/^\d+$/.test(word)));
}
/** The content words of an image that a piece of reusable text would carry ([] = content-agnostic). */
export const leakedContent = (text: string, content: ReadonlySet<string>) => [...new Set(tokens(text).filter(word => content.has(word)))];
