/**
 * Template C's side of the test generator: a Template C creative is decomposed by Template C, with Template C's own
 * options ("Separate individual people / human subjects", "Separate repeated subject / showcase panels",
 * layerizeTemplateC.ts) and nothing of Template A's held-object choice or Template B's option. Its fields and prompt
 * wording are its profile (shared/src/templateCGeneration.ts); the multi-ratio mechanics are shared
 * (generationGroups.ts).
 */
import { templateCGenerationProfile } from '@frameflow/shared';
import { declaredOptionsDecomposition } from './generationHandoff.js';
import type { GenerationHandoff } from './generationGroups.js';

export const templateCHandoff: GenerationHandoff = { profile: templateCGenerationProfile, decomposition: declaredOptionsDecomposition('template-c') };
