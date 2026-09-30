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
/** The aspect-ratio variants of one creative, and the exact pixel size requested for each (both sides divisible by 16). */
export const TEMPLATE_A_IMAGE_SIZES = { '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1536, height: 864 }, '4:5': { width: 1216, height: 1520 } } as const;
export type TemplateAAspectRatio = keyof typeof TEMPLATE_A_IMAGE_SIZES;
export const TEMPLATE_A_ASPECT_RATIOS = Object.keys(TEMPLATE_A_IMAGE_SIZES) as TemplateAAspectRatio[];
/** A variant's id inside its group: its ratio, as a file-safe word ("16:9" → "16x9"). */
export const templateAVariantId = (aspectRatio: string) => aspectRatio.replace(':', 'x');
/**
 * base: the shared creative prompt, built or edited (the app's prompt limit, AI_LIMITS.prompt). final: a variant's whole
 * prompt (base + consistency + framing). Written out rather than read from AI_LIMITS, which may not be initialised yet
 * when this module is loaded through ai.ts.
 */
export const TEMPLATE_A_PROMPT_LIMITS = { base: 2000, final: 3000 } as const;

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
/** "smartphone" → "a smartphone"; kept when it already has an article, possessive, number or is plural. */
export function withArticle(noun: string): string {
  if (/^(?:a|an|the|one|two|three|four|some|his|her|their|its|my|your|pair of)\b/i.test(noun) || /^\d/.test(noun)) return noun;
  if (/[^s]s$/i.test(noun.split(' ').pop() ?? '')) return noun;
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

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
 * The shared base prompt of a creative: built from the fields, or the text the user edited it to. An edit is tidied to
 * one line; it must still be a description (not a few characters) and fit the base limit. Nothing is cut to fit.
 */
export function resolveTemplateABasePrompt(values: TemplateAFieldValues, edited?: unknown): { builtPrompt: string; basePrompt: string; promptEdited: boolean; errors: string[] } {
  let builtPrompt = '';
  const errors: string[] = [];
  try { builtPrompt = buildTemplateAPrompt(values); } catch (error) { errors.push(`${error instanceof Error ? error.message : String(error)} Shorten some fields.`); }
  if (edited === undefined || edited === null) return { builtPrompt, basePrompt: builtPrompt, promptEdited: false, errors };
  if (typeof edited !== 'string') return { builtPrompt, basePrompt: builtPrompt, promptEdited: false, errors: [...errors, 'The edited prompt must be text.'] };
  const basePrompt = edited.replace(/\s+/g, ' ').trim();
  if ((basePrompt.match(/\p{L}/gu) ?? []).length < 20) errors.push('The edited prompt is too short to describe the creative.');
  if (basePrompt.length > TEMPLATE_A_PROMPT_LIMITS.base) errors.push(`The edited prompt is ${basePrompt.length} characters; at most ${TEMPLATE_A_PROMPT_LIMITS.base}.`);
  return { builtPrompt, basePrompt, promptEdited: basePrompt !== builtPrompt, errors };
}

/**
 * The exact prompt of one aspect-ratio variant: the shared base prompt, the consistency sentence, and that ratio's
 * framing. The base is used as it is for every ratio, so two variants of a creative differ in their framing sentence
 * and in nothing else.
 */
export function buildTemplateAVariantPrompt(basePrompt: string, aspectRatio: TemplateAAspectRatio): string {
  const framing = TEMPLATE_A_RATIO_FRAMING[aspectRatio];
  if (!framing) throw new Error(`Aspect ratio must be one of ${TEMPLATE_A_ASPECT_RATIOS.join(', ')}.`);
  const prompt = `${basePrompt.trim()} ${TEMPLATE_A_CONSISTENCY} ${framing}`;
  if (prompt.length > TEMPLATE_A_PROMPT_LIMITS.final) throw new Error(`The ${aspectRatio} prompt is ${prompt.length} characters; at most ${TEMPLATE_A_PROMPT_LIMITS.final}.`);
  return prompt;
}
