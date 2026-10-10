/**
 * Image generation sizes and prompt mechanics shared by every flow that asks the image model for a picture (reference
 * creatives, template edits). Nothing here describes what a creative shows.
 */

/** The aspect ratios the image model is asked for, and the exact pixel size of each (both sides divisible by 16). */
export const GENERATION_IMAGE_SIZES = { '1:1': { width: 1024, height: 1024 }, '16:9': { width: 1536, height: 864 }, '4:5': { width: 1216, height: 1520 } } as const;
export type GenerationAspectRatio = keyof typeof GENERATION_IMAGE_SIZES;
export const GENERATION_ASPECT_RATIOS = Object.keys(GENERATION_IMAGE_SIZES) as GenerationAspectRatio[];
/** A variant's id: its ratio, as a file-safe word ("16:9" → "16x9"). */
export const generationVariantId = (aspectRatio: string) => aspectRatio.replace(':', 'x');
/**
 * base: the creative prompt, built or edited (the app's prompt limit, AI_LIMITS.prompt). final: a ratio's whole prompt
 * (base + consistency + framing). Written out rather than read from AI_LIMITS, which may not be initialised yet when this
 * module is loaded through ai.ts.
 */
export const GENERATION_PROMPT_LIMITS = { base: 2000, final: 3000 } as const;
/** The supported size closest to an image's own aspect ratio: an edit keeps the composition's proportions. */
export function closestGenerationRatio(width: number, height: number): GenerationAspectRatio {
  const aspect = Math.log(width / height);
  return GENERATION_ASPECT_RATIOS.reduce((best, ratio) => {
    const { width: w, height: h } = GENERATION_IMAGE_SIZES[ratio], b = GENERATION_IMAGE_SIZES[best];
    return Math.abs(Math.log(w / h) - aspect) < Math.abs(Math.log(b.width / b.height) - aspect) ? ratio : best;
  }, GENERATION_ASPECT_RATIOS[0]);
}
/**
 * A canvas at an image's OWN aspect ratio, for edits of an existing creative (Feature 2): both sides divisible by 16,
 * about `pixels` in area, the ratio held between 1:3 and 3:1 (what gpt-image-2 accepts). A creative edited on another
 * ratio's canvas is padded, and the model composes across the padding: mapped back, its products come out larger and cut
 * at the edges. Feature 1 composes new scenes and keeps its own ratio sizes (GENERATION_IMAGE_SIZES).
 */
export function editCanvasSize(width: number, height: number, pixels = 1024 * 1536): { width: number; height: number } {
  const ratio = Math.min(3, Math.max(1 / 3, width / height)), snap = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  const w = snap(Math.sqrt(pixels * ratio));
  return { width: w, height: snap(w / ratio) };
}

/**
 * The exact prompt of one aspect-ratio variant: the shared base prompt, the consistency sentence, and the framing
 * sentence for that ratio. Two variants of a creative differ in their framing sentence and in nothing else.
 */
export function buildGenerationVariantPrompt(parts: { consistency: string; framing: Partial<Record<GenerationAspectRatio, string>> }, basePrompt: string, aspectRatio: GenerationAspectRatio): string {
  const framing = parts.framing[aspectRatio];
  if (!framing) throw new Error(`Aspect ratio must be one of ${GENERATION_ASPECT_RATIOS.join(', ')}.`);
  const prompt = `${basePrompt.trim()} ${parts.consistency} ${framing}`;
  if (prompt.length > GENERATION_PROMPT_LIMITS.final) throw new Error(`The ${aspectRatio} prompt is ${prompt.length} characters; at most ${GENERATION_PROMPT_LIMITS.final}.`);
  return prompt;
}
