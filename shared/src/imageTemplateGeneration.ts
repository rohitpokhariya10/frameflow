/**
 * "Create Template from Image": what the client and the server share about a template made from a reference image.
 *
 * The creative team uploads a reference image. OpenAI describes its visual structure; the user can edit that prompt
 * and pick aspect ratios. Every ratio adapts the original uploaded image, never another generated ratio's image.
 * Every ratio's prompt is built the same way as the Template A/B/C generators build theirs (templateGeneration.ts):
 *
 *     the template's prompt  +  the consistency sentence  +  that ratio's framing sentence
 *
 * This module only adds the wording of those sentences, the ratios offered and their order, and the rules a name and a
 * prompt must follow. The sizes, the limits and how a ratio's prompt is assembled are the shared ones; nothing here
 * belongs to Template A, B or C.
 */
import { buildGenerationVariantPrompt, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS, type GenerationAspectRatio } from './templateGeneration.js';

export const IMAGE_TEMPLATE_VERSION = 'image-template-v1';
/** The ratios offered, in the order they are shown and generated. */
export const IMAGE_TEMPLATE_RATIOS = ['1:1', '4:5', '16:9'] as const satisfies readonly GenerationAspectRatio[];
export type ImageTemplateRatio = typeof IMAGE_TEMPLATE_RATIOS[number];
/** How each ratio is named to the user. */
export const IMAGE_TEMPLATE_RATIO_NAMES: Record<ImageTemplateRatio, string> = { '1:1': 'Square', '4:5': 'Portrait', '16:9': 'Landscape' };
export const IMAGE_TEMPLATE_SIZES: Record<ImageTemplateRatio, { width: number; height: number }> = {
  '1:1': GENERATION_IMAGE_SIZES['1:1'], '4:5': GENERATION_IMAGE_SIZES['4:5'], '16:9': GENERATION_IMAGE_SIZES['16:9'],
};

/** Added to every ratio's prompt, word for word: what stays the same between the ratios of one template. */
export const IMAGE_TEMPLATE_CONSISTENCY = 'Adapt the original uploaded reference with minimal reinterpretation. Apply explicit edits in the prompt above; otherwise the reference governs exact subject/product geometry and details (including camera modules), object count, relative sizes and positions, orientation, camera view, framing, overlaps and depth, visual hierarchy, palette, lighting, materials/textures and background. Do not otherwise add or remove objects, redesign products or props, invent text/logos/branding, change object arrangements, stretch objects or newly crop important elements.';
/** The one thing that differs between the ratios of a template. */
export const IMAGE_TEMPLATE_FRAMING: Record<ImageTemplateRatio, string> = {
  '1:1': 'Framing for this version: 1:1, square. Preserve the original layout, crop and object arrangement; keep off-centre elements off-centre. Make only minimal framing changes, extending existing background if needed.',
  '4:5': 'Framing for this version: 4:5. Adapt the same creative vertically by extending existing background above/below or minimally reframing. Preserve relative hierarchy, sizes, positions and overlaps.',
  '16:9': 'Framing for this version: 16:9. Adapt the same creative horizontally by extending existing background at the sides or minimally reframing. Preserve relative hierarchy, sizes, positions and overlaps.',
};
/** Added to every ratio's edit request, which always carries the original uploaded reference. */
export const IMAGE_TEMPLATE_REFERENCE_INSTRUCTION = 'The attached image is the original uploaded reference, the canonical source for every ratio. Preserve its details over vague prompt wording; never copy another generated variant.';
/** The installed OpenAI SDK's GPT Image edit limit. Our existing application contract is intentionally smaller. */
export const GPT_IMAGE_PROMPT_LIMIT = 32_000;
export const IMAGE_TEMPLATE_REQUEST_LIMIT = Math.min(GENERATION_PROMPT_LIMITS.final, GPT_IMAGE_PROMPT_LIMIT);
/** Includes the three spaces added when joining the four request parts. Derived whenever wording changes. */
export const IMAGE_TEMPLATE_INSTRUCTION_HEADROOM = IMAGE_TEMPLATE_CONSISTENCY.length
  + Math.max(...Object.values(IMAGE_TEMPLATE_FRAMING).map(text => text.length)) + IMAGE_TEMPLATE_REFERENCE_INSTRUCTION.length + 3;
export const IMAGE_TEMPLATE_LIMITS = { name: 80, prompt: Math.min(GENERATION_PROMPT_LIMITS.base,
  IMAGE_TEMPLATE_REQUEST_LIMIT - IMAGE_TEMPLATE_INSTRUCTION_HEADROOM) } as const;
/** Also used at the provider boundary, after the reference instruction has been appended. Never rewrites user text. */
export function validateImageTemplateRequestPrompt(prompt: string): void {
  if (prompt.length > IMAGE_TEMPLATE_REQUEST_LIMIT) throw new Error(`The complete image prompt is ${prompt.length} characters; at most ${IMAGE_TEMPLATE_REQUEST_LIMIT}. No image request was sent.`);
}
/** The framing and consistency sentences in the shape the shared prompt builder takes. */
export const IMAGE_TEMPLATE_PROMPT_PARTS = { consistency: IMAGE_TEMPLATE_CONSISTENCY, framing: { ...IMAGE_TEMPLATE_FRAMING } as Record<GenerationAspectRatio, string> };

export const isImageTemplateRatio = (value: unknown): value is ImageTemplateRatio => IMAGE_TEMPLATE_RATIOS.includes(value as ImageTemplateRatio);
/** The ratios chosen, each once and in the fixed order, or why they cannot be used. */
export function resolveImageTemplateRatios(input: unknown): { ratios: ImageTemplateRatio[]; error?: string } {
  if (!Array.isArray(input) || !input.every(isImageTemplateRatio) || new Set(input).size !== input.length) return { ratios: [], error: `Aspect ratios must be one or more of ${IMAGE_TEMPLATE_RATIOS.join(', ')}, each once.` };
  if (!input.length) return { ratios: [], error: 'Choose at least one aspect ratio.' };
  return { ratios: IMAGE_TEMPLATE_RATIOS.filter(ratio => input.includes(ratio)) };
}
/** A template's name, tidied to one line, or why it cannot be used. */
export function resolveImageTemplateName(input: unknown): { name: string; error?: string } {
  if (typeof input !== 'string') return { name: '', error: 'The template name must be text.' };
  const name = input.replace(/\s+/g, ' ').trim();
  if (!name) return { name, error: 'Give the template a name.' };
  if (name.length > IMAGE_TEMPLATE_LIMITS.name) return { name, error: `The template name is ${name.length} characters; at most ${IMAGE_TEMPLATE_LIMITS.name}.` };
  return { name };
}
/**
 * The template's prompt exactly as edited, and long enough to describe an image and
 * no longer than the limit. Nothing is ever cut to fit.
 */
export function resolveImageTemplatePrompt(input: unknown): { prompt: string; error?: string } {
  if (typeof input !== 'string') return { prompt: '', error: 'The prompt must be text.' };
  const prompt = input;
  if (!prompt.trim()) return { prompt, error: 'Generate a prompt from the image, or write one.' };
  if (prompt.length > IMAGE_TEMPLATE_LIMITS.prompt) return { prompt, error: `The prompt is ${prompt.length} characters; at most ${IMAGE_TEMPLATE_LIMITS.prompt}.` };
  if ((prompt.match(/\p{L}/gu) ?? []).length < 20) return { prompt, error: 'The prompt is too short to describe an image.' };
  return { prompt };
}
/** The exact prompt of one ratio: the template's prompt, the consistency sentence and that ratio's framing. */
export const imageTemplateVariantPrompt = (prompt: string, ratio: ImageTemplateRatio) => buildGenerationVariantPrompt(IMAGE_TEMPLATE_PROMPT_PARTS, prompt, ratio);
