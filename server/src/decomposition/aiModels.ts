/**
 * The AI models of the layerize experiment, named in one place. No route, runner or component names a model itself.
 *
 *   decomposition planner (and the optional template fit check)   OpenAI   OPENAI_DECOMPOSITION_MODEL
 *   Template A source-image generation                            OpenAI   OPENAI_IMAGE_MODEL
 *   decomposition                                                 fal      Seedream Layerize (endpointRegistry, providers/adapters.ts)
 *
 * A configured model is used as given and never silently substituted.
 */
export const DEFAULT_PLANNER_MODEL = 'gpt-5-mini';
/** "OpenAI Image 2": the identifier in the OpenAI SDK's ImageModel list (openai 7.23.0, checked 2026-09-30). */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

export const plannerModel = (env = process.env) => env.OPENAI_DECOMPOSITION_MODEL?.trim() || DEFAULT_PLANNER_MODEL;
export function imageModel(env = process.env): string {
  const model = env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
  // An OpenAI model id has no path: a fal endpoint id left over from the text-to-image generator is refused.
  if (!/^[A-Za-z0-9][\w.:-]*$/.test(model)) throw new Error('OPENAI_IMAGE_MODEL must be an OpenAI image model id, e.g. gpt-image-2.');
  return model;
}
