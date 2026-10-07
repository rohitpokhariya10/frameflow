/**
 * The AI models of the layerize experiment, named in one place. No route, runner or component names a model itself.
 *
 *   decomposition planner (and the optional template fit check)   OpenAI   OPENAI_DECOMPOSITION_MODEL
 *   Template A source-image generation                            OpenAI   OPENAI_IMAGE_MODEL
 *   decomposition                                                 fal      Seedream Layerize (endpointRegistry, providers/adapters.ts)
 *   template family structure, low cost (ambiguous/new creatives)  OpenAI   OPENAI_STRUCTURE_CHEAP_MODEL
 *   template family structure, escalation only                    OpenAI   OPENAI_STRUCTURE_STRONG_MODEL
 *
 * A configured model is used as given and never silently substituted.
 */
export const DEFAULT_PLANNER_MODEL = 'gpt-5-mini';
/** Decomposition-only default, verified in OpenAI SDK 7.23.0 and the GPT-5.6 Sol model docs. */
export const DEFAULT_DECOMPOSITION_PLANNER_MODEL = 'gpt-5.6-sol';
export const decompositionPlannerModel = (env = process.env) => env.OPENAI_DECOMPOSITION_MODEL?.trim() || DEFAULT_DECOMPOSITION_PLANNER_MODEL;
/** "OpenAI Image 2": the identifier in the OpenAI SDK's ImageModel list (openai 7.23.0, checked 2026-09-30). */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

export const plannerModel = (env = process.env) => env.OPENAI_DECOMPOSITION_MODEL?.trim() || DEFAULT_PLANNER_MODEL;
export function imageModel(env = process.env): string {
  const model = env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  // An OpenAI model id has no path: a fal endpoint id left over from the text-to-image generator is refused.
  if (!/^[A-Za-z0-9][\w.:-]*$/.test(model)) throw new Error('OPENAI_IMAGE_MODEL must be an OpenAI image model id, e.g. gpt-image-2.');
  return model;
}

/**
 * Template family structural analysis (templateFamilies/structurePlanner.ts). A known family needs neither; an ambiguous
 * or new creative gets the low-cost model once, and the strong model only when that answer fails validation.
 */
export const DEFAULT_STRUCTURE_CHEAP_MODEL = 'gpt-5.6-luna';
export const DEFAULT_STRUCTURE_STRONG_MODEL = 'gpt-5.6-sol';
export const structureCheapModel = (env = process.env) => env.OPENAI_STRUCTURE_CHEAP_MODEL?.trim() || DEFAULT_STRUCTURE_CHEAP_MODEL;
export const structureStrongModel = (env = process.env) => env.OPENAI_STRUCTURE_STRONG_MODEL?.trim() || DEFAULT_STRUCTURE_STRONG_MODEL;
