/**
 * The decomposition handoff of a template whose decomposition is steered by its own declared options (its
 * TemplateDefinition.options, layerizeTemplates.ts) rather than by Template A's held-object choice. It is a mechanism:
 * which options exist, what they are called and what they mean belongs to the decomposition template that declares
 * them. An option the template does not declare, another template's, is refused, never passed on.
 */
import type { GenerationTemplateKey } from '@frameflow/shared';
import { allowOnly, type GenerationHandoff } from './generationGroups.js';
import { RunError } from './layerizeExperiment.js';
import { requireTemplate, suggestedLayerCount, targetLayersProblem, templateOptionsFor } from './layerizeTemplates.js';

/** Body: { templateOptions?: { <the template's own option>: boolean }, targetLayers?: number, skipFitCheck?: boolean }. */
export function declaredOptionsDecomposition(templateKey: GenerationTemplateKey): GenerationHandoff['decomposition'] {
  return (_group, body) => {
    const template = requireTemplate(templateKey);
    allowOnly(body, ['templateOptions', 'targetLayers', 'skipFitCheck'], template.name);
    if (body.skipFitCheck !== undefined && typeof body.skipFitCheck !== 'boolean') throw new RunError('INVALID_REQUEST', 'skipFitCheck must be true or false.');
    if (body.targetLayers !== undefined && typeof body.targetLayers !== 'number') throw new RunError('INVALID_TARGET_LAYERS', 'targetLayers must be a number.');
    // Every declared option with its value (defaults filled in); an undeclared one throws here.
    const templateOptions = templateOptionsFor(templateKey, body.templateOptions);
    if (!templateOptions) throw new RunError('INVALID_REQUEST', `${template.name} declares no decomposition options.`);
    // These templates have no fixed layer count: the natural count is found by the decomposition. A target is optional.
    const targetLayers = body.targetLayers as number | undefined;
    const problem = targetLayers === undefined ? undefined : targetLayersProblem(templateKey, true, targetLayers);
    if (problem) throw new RunError('INVALID_TARGET_LAYERS', problem);
    const suggestedLayers = suggestedLayerCount(templateKey, true);
    return { run: { templateOptions, layerTarget: { templateKey, ...(suggestedLayers !== undefined ? { suggestedLayers } : {}), ...(targetLayers !== undefined ? { targetLayers } : {}) }, skipFitCheck: body.skipFitCheck === true },
      entry: { templateOptions, ...(targetLayers !== undefined ? { targetLayers } : {}) } };
  };
}
