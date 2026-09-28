/**
 * Template prompts for the layerize experiment: an OpenAI-generated Seedream prompt from one representative run, saved
 * under a template key and reused verbatim for other images of the same composition (no OpenAI call). Stored as one
 * JSON file next to the run folders. Saving again replaces the template's prompt; every earlier prompt still lives in
 * its own run folder (prompt.txt).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayerizePlan } from './layerizePlanner.js';
import { readRun, RunError, templateKeyOf, validRunId } from './layerizeExperiment.js';

/**
 * Expected semantic layers, in the order Seedream returns them. `heldObject` layers exist only when the held/secondary
 * object is separate; `foreground` layers are kept apart from the background by the output layer count.
 */
export type LayerRole = { name: string; heldObject?: boolean; foreground?: boolean };
/**
 * A template: its semantic roles, the checkbox that controls its foreground grouping, and its post-processing policy.
 * `dynamicLayerCount`: the natural (suggested) count comes from the decomposition itself, not from fixed roles.
 * `outerBackgroundRebuild`: the framed-layout outer-background rebuild (Template A only; it would flatten structured
 * poster backgrounds). `normalization`: the merge strategy for an exact output layer count (layerCount.ts).
 */
export type TemplateDefinition = {
  key: string; name: string; description: string; layerRoles: LayerRole[]; dynamicLayerCount?: boolean;
  grouping: { label: string; checked: string; unchecked: string; minReason: string; modeName: string };
  outerBackgroundRebuild: boolean; normalization: 'template-a' | 'template-b';
  /** 'planned': OpenAI writes the Seedream prompt (Template A). 'automatic': Seedream gets no prompt and picks the major
   * elements itself; OpenAI is not called and roles are classified locally (Template B: every prompted Template B run
   * was rejected by Seedream, the empty-prompt run succeeded). */
  providerPrompt: 'planned' | 'automatic';
};
/** Seedream layerize returns a base image plus at most 16 layers. */
export const MAX_OUTPUT_LAYERS = 17;
/** Known templates. Each has its own planner and provider prompt (layerizePlanner.ts) and its own saved prompt. */
export const TEMPLATES: TemplateDefinition[] = [{ key: 'template-a', name: 'Template A',
  description: 'Framed ad portrait: outer background, inner framed backdrop, one main subject (person or animal) holding one object (phone, board, dumbbell, product, sign).',
  // Every Template A run so far returned exactly these: 6 layers with the held object separate, 5 with it combined.
  layerRoles: [{ name: 'Base (clean scene)' }, { name: 'Outer background' }, { name: 'Inner backdrop' }, { name: 'Decorative border' },
    { name: 'Main subject', foreground: true }, { name: 'Held object', heldObject: true, foreground: true }],
  grouping: { label: 'Separate held object from subject', checked: 'Checked: subject and held object become separate layers.', unchecked: 'Unchecked: held object stays combined with the subject.',
    minReason: 'background, subject and held object', modeName: 'Held object mode' },
  outerBackgroundRebuild: true, normalization: 'template-a', providerPrompt: 'planned' }, { key: 'template-b', name: 'Template B',
  description: 'Product/editorial poster with one main hero object, background/backdrop, optional support, secondary props and grouped decorative graphics.',
  // Typical roles, informational only: not every poster has every role, so the suggested count comes from the decomposition.
  layerRoles: [{ name: 'Base' }, { name: 'Background' }, { name: 'Backdrop / panel' }, { name: 'Decorative graphics (grouped)' }, { name: 'Support / pedestal' },
    { name: 'Main product', foreground: true }, { name: 'Secondary object', heldObject: true, foreground: true }, { name: 'Raster text / badge' }],
  dynamicLayerCount: true,
  grouping: { label: 'Separate secondary object from main product', checked: 'Checked: a meaningful secondary object stays a separate layer.', unchecked: 'Unchecked: a secondary object stays combined with the main product.',
    minReason: 'background, main product and secondary object', modeName: 'Secondary object mode' },
  outerBackgroundRebuild: false, normalization: 'template-b', providerPrompt: 'automatic' }];
export function requireTemplate(key: string): TemplateDefinition {
  const definition = templateDefinition(key);
  if (!definition) throw new RunError('UNKNOWN_TEMPLATE', `Unknown template "${key}".`);
  return definition;
}
/**
 * Suggested layer count before a run: the template's expected semantic layers, including the base. Undefined for
 * templates whose natural count is only known after decomposition (Template B). Guidance, not a guarantee.
 */
export function suggestedLayerCount(key: string, separateHeldObject: boolean): number | undefined {
  const definition = requireTemplate(key);
  if (definition.dynamicLayerCount) return undefined;
  return definition.layerRoles.filter(role => separateHeldObject || !role.heldObject).length;
}
/**
 * Allowed exact output layer counts (including the base). Layers are only merged, never split, so the maximum is the
 * natural count: the fixed suggested count, or for dynamic templates the count found in a decomposition (`natural`),
 * up to Seedream's limit before one exists. In separate mode at least one background layer plus every foreground role,
 * so the two foreground layers stay separate (the checkbox contract); in combined mode anything down to 1.
 */
export function targetLayerRange(key: string, separateHeldObject: boolean, natural?: number): { min: number; max: number } {
  const definition = requireTemplate(key);
  const roles = definition.layerRoles.filter(role => separateHeldObject || !role.heldObject);
  const min = separateHeldObject ? 1 + roles.filter(role => role.foreground).length : 1;
  return { min, max: definition.dynamicLayerCount ? Math.max(min, natural ?? MAX_OUTPUT_LAYERS) : roles.length };
}
/** Why a target layer count is not allowed for this template and mode, or undefined when it is. */
export function targetLayersProblem(key: string, separateHeldObject: boolean, targetLayers: number, natural?: number): string | undefined {
  const definition = requireTemplate(key), { min, max } = targetLayerRange(key, separateHeldObject, natural);
  if (!Number.isInteger(targetLayers) || targetLayers < min || targetLayers > max) {
    const why = definition.dynamicLayerCount ? (natural !== undefined ? `${max} is this decomposition's natural semantic layer count` : `${max} is Seedream's layer limit; the natural count is known after decomposition`) : `${max} is the natural semantic layer count`;
    return separateHeldObject && Number.isInteger(targetLayers) && targetLayers >= 1 && targetLayers < min
      ? `Target layers ${targetLayers} is too low for separate mode: ${definition.grouping.minReason} need at least ${min} layers. Choose ${min}–${max}, or uncheck "${definition.grouping.label}" to allow fewer.`
      : `Target layers must be a whole number from ${min} to ${max} for ${definition.name} in ${separateHeldObject ? 'separate' : 'combined'} mode (${why}).`;
  }
  return undefined;
}

export type SavedTemplatePrompt = LayerizePlan & {
  templateKey: string; templateName: string; savedAt: string; notes?: string;
  sourceRunId: string; sourceImage: { file: string; width: number; height: number };
  plannerModel: string; plannerResponseId?: string;
};
export type TemplateEntry = TemplateDefinition & { saved?: SavedTemplatePrompt };

const FILE = 'templates.json';
function readStore(runsDir: string): Record<string, SavedTemplatePrompt> {
  const file = join(runsDir, FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).templates ?? {}) : {};
}
export const templateDefinition = (key: string) => TEMPLATES.find(t => t.key === key);
export function listTemplates(runsDir: string): TemplateEntry[] {
  const store = readStore(runsDir);
  return TEMPLATES.map(t => ({ ...t, ...(store[t.key] ? { saved: store[t.key] } : {}) }));
}
export function getTemplatePrompt(runsDir: string, key: string): SavedTemplatePrompt {
  const definition = templateDefinition(key);
  if (!definition) throw new RunError('UNKNOWN_TEMPLATE', `Unknown template "${key}".`);
  const saved = readStore(runsDir)[key];
  if (!saved) throw new RunError('TEMPLATE_PROMPT_MISSING', `${definition.name} has no saved prompt yet. Generate a prompt from a representative image and save it first.`);
  return saved;
}

/** Saves the OpenAI-generated prompt of a run as the template's prompt. Only runs that generated their own prompt qualify. */
export function saveTemplatePrompt(runsDir: string, key: string, runId: string, notes?: string): SavedTemplatePrompt {
  const definition = templateDefinition(key);
  if (!definition) throw new RunError('UNKNOWN_TEMPLATE', `Unknown template "${key}".`);
  if (definition.providerPrompt === 'automatic') throw new RunError('PROMPT_NOT_USED', `${definition.name} sends Seedream no prompt (automatic major elements), so there is no prompt to save.`);
  if (!validRunId(runId) || !existsSync(join(runsDir, runId, 'run.json'))) throw new RunError('NOT_FOUND', 'Run not found.');
  const run = readRun(join(runsDir, runId));
  if (run.promptSource?.mode === 'template') throw new RunError('NOT_A_GENERATED_PROMPT', `This run reused ${run.promptSource.templateName}'s prompt; save a prompt from a run that generated its own.`);
  if (!run.planner?.prompt) throw new RunError('NO_GENERATED_PROMPT', 'This run has no OpenAI-generated prompt to save.');
  // Each template keeps its own prompt: a prompt generated for one template is never saved under another.
  const runTemplate = templateKeyOf(run);
  if (runTemplate !== key) throw new RunError('TEMPLATE_MISMATCH', `This prompt was generated for ${templateDefinition(runTemplate)?.name ?? runTemplate}, not ${definition.name}.`);
  const saved: SavedTemplatePrompt = { templateKey: key, templateName: definition.name, prompt: run.planner.prompt, planned_layers: run.planner.planned_layers, warnings: run.planner.warnings,
    sourceRunId: run.id, sourceImage: { file: run.original.file, width: run.original.width, height: run.original.height }, plannerModel: run.planner.model, plannerResponseId: run.planner.responseId,
    savedAt: new Date().toISOString(), ...(notes?.trim() ? { notes: notes.trim().slice(0, 2000) } : {}) };
  const store = { ...readStore(runsDir), [key]: saved };
  const file = join(runsDir, FILE), temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ templates: store }, null, 2));
  renameSync(temp, file);
  return saved;
}
