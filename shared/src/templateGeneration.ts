/**
 * Multi-ratio creative generation: the mechanics every template shares, and nothing a template means.
 *
 * One creative is defined once and generated as a group of aspect-ratio variants (1:1, 16:9, 4:5). A variant's prompt
 * is always:   base prompt  +  consistency sentence  +  that ratio's framing sentence.
 *
 * What is shared, here: the ratios and sizes, variant ids, prompt limits, field validation mechanics, and how those
 * three parts are put together. What is NOT here: any field, any wording, any rule about what a creative shows. Those
 * belong to a template's own GenerationProfile (templateAGeneration.ts, templateBGeneration.ts, templateCGeneration.ts),
 * one module per visual family. This file never looks at which template it is working for.
 *
 * Expected consistency: the variants of a group are the SAME CREATIVE FAMILY: the same subjects or products, the same
 * visual identity and theme, the same modules and object relationships, framed for each ratio. They are not
 * pixel-identical: each ratio is a separate text-to-image request from the same description, so what the description
 * does not pin down can differ between them.
 */
export const GENERATION_TEMPLATE_KEYS = ['template-a', 'template-b', 'template-c'] as const;
export type GenerationTemplateKey = typeof GENERATION_TEMPLATE_KEYS[number];

/** The aspect-ratio variants of one creative, and the exact pixel size requested for each (both sides divisible by 16). */
export const GENERATION_IMAGE_SIZES = { '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1536, height: 864 }, '4:5': { width: 1216, height: 1520 } } as const;
export type GenerationAspectRatio = keyof typeof GENERATION_IMAGE_SIZES;
export const GENERATION_ASPECT_RATIOS = Object.keys(GENERATION_IMAGE_SIZES) as GenerationAspectRatio[];
/** A variant's id inside its group: its ratio, as a file-safe word ("16:9" → "16x9"). */
export const generationVariantId = (aspectRatio: string) => aspectRatio.replace(':', 'x');
/**
 * base: the shared creative prompt, built or edited (the app's prompt limit, AI_LIMITS.prompt). final: a variant's whole
 * prompt (base + consistency + framing). Written out rather than read from AI_LIMITS, which may not be initialised yet
 * when this module is loaded through ai.ts.
 */
export const GENERATION_PROMPT_LIMITS = { base: 2000, final: 3000 } as const;

export type GenerationField = { key: string; label: string; default: string; required: boolean; maxLength: number; help: string };
export type GenerationFieldValues = Record<string, string>;
/**
 * Everything one template knows about generating its creatives. A profile is self-contained: its fields, its validation,
 * its prompt skeleton, its consistency and framing sentences and its warnings are written for its own visual family and
 * are used by no other template.
 */
export interface GenerationProfile {
  templateKey: GenerationTemplateKey; name: string; version: string;
  /** The visual family, as shown above the form. */
  family: string;
  /** What stays the same across the ratios of a creative of this template, as shown to the user. */
  sameAcrossRatios: string;
  /** Examples of what a description does not pin down, and so can differ between the ratios, as shown to the user. */
  mayDiffer: string;
  /** The fixed prompt structure, shown read-only; [ ] marks wording dropped when its field is empty, | alternatives. */
  skeleton: string;
  fields: readonly GenerationField[];
  defaults: GenerationFieldValues;
  /** Added to every variant, word for word: what stays the same across the aspect ratios. */
  consistency: string;
  /** The one thing that differs between the variants of a creative: how it is framed in that ratio. Fixed text. */
  framing: Record<GenerationAspectRatio, string>;
  /** The field values for a creative (defaults filled in, tidied), or what is wrong with them. */
  resolveFields: (input: unknown) => { values: GenerationFieldValues; errors: string[] };
  /** The shared base prompt: the skeleton filled from the values. Throws when it is over the limit. */
  buildBasePrompt: (values: GenerationFieldValues) => string;
  /** Things worth knowing about this creative before it is generated or decomposed. Never blocking. */
  notes: (values: GenerationFieldValues) => string[];
  /** A few words naming the creative, for history lists. */
  summarize: (values: GenerationFieldValues) => string;
}

/** One line, no trailing punctuation. */
export const tidyFieldValue = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
/** A field value that means "none": empty, or "no …", "none", "nothing", "without …". */
export const meansNone = (value: string | undefined) => !value || /^(?:no\b|none\b|nothing\b|without\b)/i.test(value.trim());
/**
 * Whether a description says that something is the case ("two of them touch it"), rather than that it is not ("none
 * touching it", "not overlapping"): a mention that directly follows a negation is not counted.
 */
export const saysSo = (value: string, what: RegExp) => what.test(value.replace(new RegExp(`\\b(?:no|not|none|never|neither|nothing|without)\\b(?:\\s+\\w+){0,3}?\\s+(?:${what.source})`, 'gi'), ' '));
/** "smartphone" → "a smartphone"; kept when it already has an article, possessive, number or is plural. */
export function withArticle(noun: string): string {
  if (/^(?:a|an|the|one|two|three|four|some|his|her|their|its|my|your|pair of)\b/i.test(noun) || /^\d/.test(noun)) return noun;
  if (/[^s]s$/i.test(noun.split(' ').pop() ?? '')) return noun;
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/**
 * The field values for a creative of a template: missing fields take their default; strings are tidied (one line, no
 * trailing punctuation). Errors for unknown fields, non-text values, empty or letterless required values and over-long
 * values. `templateName` is only used to word the messages.
 */
export function resolveGenerationFields(templateName: string, fields: readonly GenerationField[], input: unknown): { values: GenerationFieldValues; errors: string[] } {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const errors: string[] = [], values: GenerationFieldValues = Object.fromEntries(fields.map(field => [field.key, field.default]));
  for (const key of Object.keys(given)) if (!fields.some(field => field.key === key)) errors.push(`Unknown field "${key}".`);
  for (const field of fields) {
    const raw = given[field.key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') { errors.push(`${field.label} must be text.`); continue; }
    const value = tidyFieldValue(raw);
    if (field.required && !/\p{L}.*\p{L}/u.test(value)) errors.push(`${field.label} is required: it is part of the ${templateName} structure.`);
    else if (value.length > field.maxLength) errors.push(`${field.label} is ${value.length} characters; at most ${field.maxLength}.`);
    values[field.key] = value;
  }
  return { values, errors };
}
/** Joins the sentences of a filled skeleton and refuses a base prompt over the limit; nothing is ever cut to fit. */
export function joinBasePrompt(sentences: (string | false | undefined)[]): string {
  const prompt = sentences.filter(Boolean).join(' ');
  if (prompt.length > GENERATION_PROMPT_LIMITS.base) throw new Error(`The generation prompt is ${prompt.length} characters; at most ${GENERATION_PROMPT_LIMITS.base}.`);
  return prompt;
}

/**
 * The shared base prompt of a creative: built from the fields by its template, or the text the user edited it to. An
 * edit is tidied to one line; it must still be a description (not a few characters) and fit the base limit.
 */
export function resolveGenerationBasePrompt(profile: Pick<GenerationProfile, 'buildBasePrompt'>, values: GenerationFieldValues, edited?: unknown): { builtPrompt: string; basePrompt: string; promptEdited: boolean; errors: string[] } {
  let builtPrompt = '';
  const errors: string[] = [];
  try { builtPrompt = profile.buildBasePrompt(values); } catch (error) { errors.push(`${error instanceof Error ? error.message : String(error)} Shorten some fields.`); }
  if (edited === undefined || edited === null) return { builtPrompt, basePrompt: builtPrompt, promptEdited: false, errors };
  if (typeof edited !== 'string') return { builtPrompt, basePrompt: builtPrompt, promptEdited: false, errors: [...errors, 'The edited prompt must be text.'] };
  const basePrompt = edited.replace(/\s+/g, ' ').trim();
  if ((basePrompt.match(/\p{L}/gu) ?? []).length < 20) errors.push('The edited prompt is too short to describe the creative.');
  if (basePrompt.length > GENERATION_PROMPT_LIMITS.base) errors.push(`The edited prompt is ${basePrompt.length} characters; at most ${GENERATION_PROMPT_LIMITS.base}.`);
  return { builtPrompt, basePrompt, promptEdited: basePrompt !== builtPrompt, errors };
}

/**
 * The exact prompt of one aspect-ratio variant: the shared base prompt, the template's consistency sentence, and the
 * template's framing sentence for that ratio. The base is used as it is for every ratio, so two variants of a creative
 * differ in their framing sentence and in nothing else.
 */
export function buildGenerationVariantPrompt(profile: Pick<GenerationProfile, 'consistency' | 'framing'>, basePrompt: string, aspectRatio: GenerationAspectRatio): string {
  const framing = profile.framing[aspectRatio];
  if (!framing) throw new Error(`Aspect ratio must be one of ${GENERATION_ASPECT_RATIOS.join(', ')}.`);
  const prompt = `${basePrompt.trim()} ${profile.consistency} ${framing}`;
  if (prompt.length > GENERATION_PROMPT_LIMITS.final) throw new Error(`The ${aspectRatio} prompt is ${prompt.length} characters; at most ${GENERATION_PROMPT_LIMITS.final}.`);
  return prompt;
}
