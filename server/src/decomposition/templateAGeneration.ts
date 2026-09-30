/**
 * Template A's side of the test generator: how a Template A creative is handed to the Template A decomposition. The
 * multi-ratio mechanics are shared (generationGroups.ts) and its fields and prompt wording are its profile
 * (shared/src/templateAGeneration.ts); what lives here is only what the Template A decomposition needs to know about a
 * generated creative.
 *
 * Decomposition defaults follow the structure the creative's fields describe (scoped to generated images; uploads keep
 * Template A's usual defaults): the held object is separate only when there is one (a creative without one cannot be
 * decomposed "separate"), and the target is Template A's natural layer count minus the border layer when the fields
 * asked for no visible border.
 */
import { hasHeldObject, hasVisibleBorder, templateAGenerationProfile, type TemplateAFieldValues } from '@frameflow/shared';
import { allowOnly, createGenerationGroup, generationsDirFor, type GenerationConfig, type GenerationHandoff } from './generationGroups.js';
import { RunError } from './layerizeExperiment.js';
import { suggestedLayerCount, targetLayersProblem } from './layerizeTemplates.js';

export const DEFAULT_GENERATIONS_DIR = generationsDirFor('template-a');
const structure = (fields: Record<string, string>) => ({ visibleBorder: hasVisibleBorder(fields as TemplateAFieldValues), heldObject: hasHeldObject(fields as TemplateAFieldValues) });

export const templateAHandoff: GenerationHandoff = {
  profile: templateAGenerationProfile,
  structure,
  // Body: { separateHeldObject?: boolean, targetLayers?: number, skipFitCheck?: boolean }. Template A has the held-object
  // choice and no options of its own; another template's options are refused.
  decomposition(group, body) {
    allowOnly(body, ['separateHeldObject', 'targetLayers', 'skipFitCheck'], 'Template A');
    for (const key of ['separateHeldObject', 'skipFitCheck'] as const) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new RunError('INVALID_REQUEST', `${key} must be true or false.`);
    if (body.targetLayers !== undefined && typeof body.targetLayers !== 'number') throw new RunError('INVALID_TARGET_LAYERS', 'targetLayers must be a number.');
    const facts = group.structure ?? structure(group.fields);
    if (body.separateHeldObject === true && !facts.heldObject) throw new RunError('INVALID_REQUEST', 'This generation has no held object, so it cannot be decomposed with the held object separate.');
    const separateHeldObject = facts.heldObject && body.separateHeldObject !== false;
    const expected = suggestedLayerCount('template-a', separateHeldObject)! - (facts.visibleBorder ? 0 : 1);
    const targetLayers = body.targetLayers ?? expected;
    const problem = targetLayersProblem('template-a', separateHeldObject, targetLayers);
    if (problem) throw new RunError('INVALID_TARGET_LAYERS', problem);
    return { run: { separateHeldObject, layerTarget: { templateKey: 'template-a', suggestedLayers: expected, targetLayers }, skipFitCheck: body.skipFitCheck === true }, entry: { separateHeldObject, targetLayers } };
  },
};

/** A new Template A group: the shared mechanics with Template A's profile. */
export const createGroup = (root: string, input: { fields?: unknown; basePrompt?: unknown; prompt?: unknown; aspectRatios?: unknown }, config: Pick<GenerationConfig, 'model'>) => createGenerationGroup(root, templateAHandoff, input, config);
export { findVariant, generateVariant, groupDir, listGroups, liveGenerationConfig, presentGroup, queueVariant, readGroup, recordDecomposition, variantImage,
  type GenerationConfig, type GenerationGroup, type GenerationVariant, type VariantDecomposition, type VariantStatus } from './generationGroups.js';
