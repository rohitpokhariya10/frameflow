/**
 * Template B's side of the test generator: a Template B creative is decomposed by Template B, with Template B's own
 * option ("Separate touching / overlapping independent objects", layerizeTemplateB.ts) and nothing of Template A's
 * held-object choice or Template C's options. Its fields and prompt wording are its profile
 * (shared/src/templateBGeneration.ts); the multi-ratio mechanics are shared (generationGroups.ts).
 */
import { templateBGenerationProfile } from '@frameflow/shared';
import { declaredOptionsDecomposition } from './generationHandoff.js';
import type { GenerationHandoff } from './generationGroups.js';

export const templateBHandoff: GenerationHandoff = { profile: templateBGenerationProfile, decomposition: declaredOptionsDecomposition('template-b') };
