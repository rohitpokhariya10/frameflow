import { templateAGenerationProfile } from '@frameflow/shared';
import { creationRequestFor, generationApiFor, generatorReducerFor, initialFormFor, resolvedCreativeFor, variantImageUrlFor, type GeneratorForm } from './templateGeneration';

/**
 * Template A's generator: the shared generator mechanics (templateGeneration.ts) bound to Template A's profile, under
 * the names the Template A flow has always used.
 */
export { isUnderway, type CreationRequest, type GenerationGroup, type GenerationVariant, type GeneratorAction, type GeneratorForm, type GeneratorInfo, type VariantStatus } from './templateGeneration';
export const generationApi = generationApiFor('template-a');
export const variantImageUrl = variantImageUrlFor('template-a');
export const initialForm = () => initialFormFor(templateAGenerationProfile);
export const generatorReducer = generatorReducerFor(templateAGenerationProfile);
export const resolvedCreative = (form: GeneratorForm) => resolvedCreativeFor(templateAGenerationProfile, form);
export const creationRequest = (form: GeneratorForm) => creationRequestFor(templateAGenerationProfile, form);
