/**
 * The generation profile of each template. This is the only place the three are named together: it picks one by key and
 * does nothing else. Each profile's rules live in its own module and are used by no other template.
 */
import { templateAGenerationProfile } from './templateAGeneration.js';
import { templateBGenerationProfile } from './templateBGeneration.js';
import { templateCGenerationProfile } from './templateCGeneration.js';
import type { GenerationProfile, GenerationTemplateKey } from './templateGeneration.js';

// Read when asked for, not when this module loads: the profile modules and this one can be loaded in any order.
export const GENERATION_PROFILES: Record<GenerationTemplateKey, GenerationProfile> = {
  get 'template-a'() { return templateAGenerationProfile; }, get 'template-b'() { return templateBGenerationProfile; }, get 'template-c'() { return templateCGenerationProfile; },
};
export function generationProfile(templateKey: string): GenerationProfile {
  if (!Object.hasOwn(GENERATION_PROFILES, templateKey)) throw new Error(`No generation profile for template "${templateKey}".`);
  return GENERATION_PROFILES[templateKey as GenerationTemplateKey];
}
