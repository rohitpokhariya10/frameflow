/**
 * Template A image generation (test/admin harness). The user edits semantic fields; the application owns the prompt: a
 * fixed Template A skeleton filled deterministically from the fields (shared by the server, which builds the prompts it
 * sends, and the client, which shows them). That shared base prompt is the one creative definition. It can be edited by
 * hand, explicitly; what is never written by hand is the final prompt of an aspect ratio.
 *
 * One creative, three aspect ratios. A creative is generated as a group of aspect-ratio variants (1:1, 16:9, 4:5). Every
 * variant's prompt is the same base prompt, the same consistency sentence, and one fixed framing sentence for its
 * ratio, so the only thing that differs between the prompts is the framing. The target is creative identity
 * consistency: the same subject, styling, held object, inner region, border and backgrounds in every ratio, reframed
 * for each. It is not pixel identity: each ratio is generated separately from the same description, so what the
 * description does not pin down (the exact face, the exact folds of a fabric) can differ between them.
 *
 * The skeleton's invariants are what Template A decomposes: one clearly dominant subject; a clearly distinguishable
 * inner region with its own backdrop, visually separate from the outer background; a simple, clean composition; an
 * optional held or featured object; no other subjects, props, text or logos. The region's shape, a border or none, the
 * framing, pose, colors and styling are field values; the defaults are examples, not rules.
 */
import { AI_LIMITS } from './ai.js';
import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS, generationVariantId, resolveGenerationBasePrompt, withArticle,
  type GenerationAspectRatio, type GenerationProfile } from './templateGeneration.js';

export const TEMPLATE_A_GENERATION_VERSION = 'template-a-generation-v3';
export type TemplateAFieldKey = 'subject' | 'subjectDetails' | 'composition' | 'heldObject' | 'pose' | 'expression' | 'outfit' | 'innerBackdrop' | 'frameShape' | 'frameBorder' | 'outerBackground' | 'lighting' | 'extraNotes';
export type TemplateAField = { key: TemplateAFieldKey; label: string; default: string; required: boolean; maxLength: number; help: string };
export type TemplateAFieldValues = Record<TemplateAFieldKey, string>;

/** Required fields carry Template A's structure; every other field is optional and drops its wording when empty. */
export const TEMPLATE_A_FIELDS: TemplateAField[] = [
  { key: 'subject', label: 'Subject', default: 'smiling adult woman', required: true, maxLength: 120, help: 'A person or an animal, e.g. young man, older woman, golden retriever dog.' },
  { key: 'subjectDetails', label: 'Subject details', default: 'natural studio portrait styling', required: false, maxLength: 200, help: 'Look, hair, age, style.' },
  { key: 'composition', label: 'Framing / composition', default: 'centered, waist-up', required: false, maxLength: 160, help: 'A preference, e.g. upper-body portrait, slightly turned to the left.' },
  { key: 'heldObject', label: 'Held / featured object', default: 'smartphone', required: false, maxLength: 120, help: 'Empty = no object.' },
  { key: 'pose', label: 'Object interaction / pose', default: 'holding the phone naturally in one hand', required: false, maxLength: 200, help: 'How the object is held, or the pose without one.' },
  { key: 'expression', label: 'Expression', default: 'warm, confident smile', required: false, maxLength: 120, help: '' },
  { key: 'outfit', label: 'Outfit / styling', default: '', required: false, maxLength: 200, help: 'Optional; leave empty for animals.' },
  { key: 'innerBackdrop', label: 'Inner backdrop', default: 'soft sky-blue studio backdrop', required: true, maxLength: 160, help: 'What fills the region behind the subject.' },
  { key: 'frameShape', label: 'Inner region shape', default: 'upright oval', required: false, maxLength: 80, help: 'Oval, circle, rounded arch, rounded rectangle, soft organic shape; empty = unspecified.' },
  { key: 'frameBorder', label: 'Border / frame treatment', default: 'thin warm-gold border', required: false, maxLength: 80, help: 'Empty or "no visible border" = none.' },
  { key: 'outerBackground', label: 'Outer background', default: 'muted forest green', required: true, maxLength: 160, help: 'Everything outside the inner region.' },
  { key: 'lighting', label: 'Lighting / mood', default: 'soft, even studio lighting', required: false, maxLength: 160, help: '' },
  { key: 'extraNotes', label: 'Extra notes', default: '', required: false, maxLength: 300, help: 'A little extra visual guidance; it cannot replace the Template A structure.' },
];
export const TEMPLATE_A_DEFAULTS = Object.fromEntries(TEMPLATE_A_FIELDS.map(f => [f.key, f.default])) as TemplateAFieldValues;
// The ratios, sizes, variant ids and limits are the generic mechanics every template's generator shares
// (templateGeneration.ts); these are the same values under the names Template A's code was written with.
export const TEMPLATE_A_IMAGE_SIZES = GENERATION_IMAGE_SIZES;
export type TemplateAAspectRatio = GenerationAspectRatio;
export const TEMPLATE_A_ASPECT_RATIOS = GENERATION_ASPECT_RATIOS;
export const templateAVariantId = generationVariantId;
export const TEMPLATE_A_PROMPT_LIMITS = GENERATION_PROMPT_LIMITS;

/** Added to every variant, word for word: what stays the same across the aspect ratios. */
export const TEMPLATE_A_CONSISTENCY = 'This image is one of several aspect-ratio versions of the same creative. Everything described above is the same in every version: the same subject, styling, held object, inner region, border and backgrounds. Only the framing changes with the aspect ratio; do not add, remove or redesign anything.';
/** The one thing that differs between the variants of a creative: how it is framed in that aspect ratio. Fixed text, never edited. */
export const TEMPLATE_A_RATIO_FRAMING: Record<TemplateAAspectRatio, string> = {
  '1:1': 'Framing for this version: 1:1, square. A balanced square composition: the inner region centred, with an even margin of the outer background on every side.',
  '16:9': 'Framing for this version: 16:9, wide. The same creative in a wide frame: the inner region keeps its shape, stays centred and fills most of the frame height, and the extra width is more of the same outer background on both sides, left empty.',
  '4:5': 'Framing for this version: 4:5, tall feed. The same creative in a slightly tall frame: the inner region centred and filling most of the frame, with a slim, even margin of the outer background around it.',
};

/** The fixed skeleton, as shown read-only; [ ] marks wording dropped when its field is empty, | alternatives. */
export const TEMPLATE_A_SKELETON = 'Create a clean, poster-style advertising portrait with one {subject}[, {subjectDetails}] as the clearly dominant subject[, {composition}]. Place the subject inside a clearly distinguishable[ {frameShape}] inner region filled with {innerBackdrop}, visually separate from the outer background, which fills the rest of the canvas with {outerBackground} and leaves a clear margin around the inner region. {The inner region is edged by {frameBorder}. | No visible border around the inner region.} {The subject holds {heldObject}[, {pose}], clearly visible and not hidden by the hands. | The subject holds no object[; {pose}], in a natural pose that keeps the subject clearly visible.} [Expression: {expression}.] [Outfit and styling: {outfit}.] [Lighting and mood: {lighting}.] The subject may be cropped by the lower edge of the inner region. Keep the composition simple and clean, with strong separation between the outer background, the inner region, the subject[ and the {heldObject}]. Realistic, sharp, high-resolution photography. No other people or animals, no unrelated props, no clutter, no text or logos. [Additional notes: {extraNotes}.]';

const tidy = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
/** A border field that means none: empty, or "no …", "none", "without …", "borderless". */
export const hasVisibleBorder = (values: Pick<TemplateAFieldValues, 'frameBorder'>) => !!values.frameBorder && !/^(?:no\b|none\b|without\b|borderless\b)/i.test(values.frameBorder.trim());
export const hasHeldObject = (values: Pick<TemplateAFieldValues, 'heldObject'>) => !!values.heldObject && !/^(?:no\b|none\b|nothing\b)/i.test(values.heldObject.trim());
export { withArticle };

/**
 * The field values for a generation: missing fields take their default; strings are tidied (one line, no trailing
 * punctuation). Errors for unknown fields, non-text values, empty or letterless required values and over-long values.
 */
export function resolveTemplateAFields(input: unknown): { values: TemplateAFieldValues; errors: string[] } {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const errors: string[] = [], values = { ...TEMPLATE_A_DEFAULTS };
  for (const key of Object.keys(given)) if (!TEMPLATE_A_FIELDS.some(f => f.key === key)) errors.push(`Unknown field "${key}".`);
  for (const field of TEMPLATE_A_FIELDS) {
    const raw = given[field.key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') { errors.push(`${field.label} must be text.`); continue; }
    const value = tidy(raw);
    if (field.required && !/\p{L}.*\p{L}/u.test(value)) errors.push(`${field.label} is required: it is part of the Template A structure.`);
    else if (value.length > field.maxLength) errors.push(`${field.label} is ${value.length} characters; at most ${field.maxLength}.`);
    values[field.key] = value;
  }
  return { values, errors };
}

/** The Template A generation prompt: the fixed skeleton filled from the fields, empty optional parts dropped. */
export function buildTemplateAPrompt(values: TemplateAFieldValues): string {
  const v = values, object = hasHeldObject(v) ? withArticle(v.heldObject) : undefined;
  const sentences = [
    `Create a clean, poster-style advertising portrait with one ${v.subject}${v.subjectDetails ? `, ${v.subjectDetails},` : ''} as the clearly dominant subject${v.composition ? `, ${v.composition}` : ''}.`,
    `Place the subject inside a clearly distinguishable ${v.frameShape ? `${v.frameShape} ` : ''}inner region filled with ${withArticle(v.innerBackdrop)}, visually separate from the outer background, which fills the rest of the canvas with ${v.outerBackground} and leaves a clear margin around the inner region.`,
    hasVisibleBorder(v) ? `The inner region is edged by ${withArticle(v.frameBorder)}.` : 'No visible border around the inner region.',
    object ? `The subject holds ${object}${v.pose ? `, ${v.pose}` : ''}, clearly visible and not hidden by the hands.` : `The subject holds no object${v.pose ? `; ${v.pose}` : ''}, in a natural pose that keeps the subject clearly visible.`,
    v.expression ? `Expression: ${v.expression}.` : '',
    v.outfit ? `Outfit and styling: ${v.outfit}.` : '',
    v.lighting ? `Lighting and mood: ${v.lighting}.` : '',
    'The subject may be cropped by the lower edge of the inner region.',
    `Keep the composition simple and clean, with strong separation between the outer background, the inner region, the subject${object ? ` and the ${v.heldObject.replace(/^(?:a|an|the)\s+/i, '')}` : ''}.`,
    'Realistic, sharp, high-resolution photography. No other people or animals, no unrelated props, no clutter, no text or logos.',
    v.extraNotes ? `Additional notes: ${v.extraNotes}.` : '',
  ];
  const prompt = sentences.filter(Boolean).join(' ');
  if (prompt.length > AI_LIMITS.prompt) throw new Error(`The generation prompt is ${prompt.length} characters; at most ${AI_LIMITS.prompt}.`);
  return prompt;
}

/**
 * The shared base prompt of a Template A creative: built from the fields, or the text the user edited it to (the generic
 * mechanics, with Template A's own builder).
 */
export function resolveTemplateABasePrompt(values: TemplateAFieldValues, edited?: unknown): { builtPrompt: string; basePrompt: string; promptEdited: boolean; errors: string[] } {
  return resolveGenerationBasePrompt({ buildBasePrompt: () => buildTemplateAPrompt(values) }, values, edited);
}

/**
 * The exact prompt of one aspect-ratio variant of a Template A creative: the shared base prompt, Template A's consistency
 * sentence, and Template A's framing for that ratio.
 */
export function buildTemplateAVariantPrompt(basePrompt: string, aspectRatio: TemplateAAspectRatio): string {
  return buildGenerationVariantPrompt({ consistency: TEMPLATE_A_CONSISTENCY, framing: TEMPLATE_A_RATIO_FRAMING }, basePrompt, aspectRatio);
}

/** Template A's generation profile: everything above, in the form the shared multi-ratio mechanics take. */
export const templateAGenerationProfile: GenerationProfile = {
  templateKey: 'template-a', name: 'Template A', version: TEMPLATE_A_GENERATION_VERSION,
  family: 'One clearly dominant subject (a person or an animal) inside a clearly distinguishable inner region with its own backdrop, visually separate from the outer background, optionally holding one object; a clean poster composition with no other subjects, props or text.',
  sameAcrossRatios: 'the subject, styling, held object, inner region, border and backgrounds', mayDiffer: 'the exact face, the exact folds of a fabric',
  skeleton: TEMPLATE_A_SKELETON, fields: TEMPLATE_A_FIELDS, defaults: TEMPLATE_A_DEFAULTS, consistency: TEMPLATE_A_CONSISTENCY, framing: TEMPLATE_A_RATIO_FRAMING,
  resolveFields: resolveTemplateAFields, buildBasePrompt: values => buildTemplateAPrompt(values as TemplateAFieldValues),
  notes: () => [], summarize: values => `${values.subject}${values.heldObject ? ` + ${values.heldObject}` : ''}`,
};
