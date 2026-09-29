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
import { TEMPLATE_B_OPTIONS } from './layerizeTemplateB.js';

/** A template's own boolean option (a checkbox), declared by the template that owns it. */
export type TemplateOption = { key: string; label: string; help: string; default: boolean };
/** A run's values for its template's options, every declared option present. */
export type TemplateOptions = Record<string, boolean>;

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
  /** The composition an image must have for this template, as the template fit check reads it (layerizeTemplateFit.ts). */
  fit: string;
  /** Template A's held-object checkbox (run.separateHeldObject). Absent for templates that declare their own `options`. */
  grouping?: { label: string; checked: string; unchecked: string; minReason: string; modeName: string };
  /** The template's own options (run.templateOptions), e.g. Template B's touching-objects checkbox. */
  options?: TemplateOption[];
  outerBackgroundRebuild: boolean; normalization: 'template-a' | 'template-b';
  /** 'planned': OpenAI writes the Seedream prompt. 'automatic': Seedream gets no prompt and picks the major elements
   * itself; OpenAI is not called (no template uses it now; kept for runs and retries made that way). */
  providerPrompt: 'planned' | 'automatic';
  /** The prompt names this image's own layers (Template B), so it is never saved as a template prompt or reused. */
  imageSpecificPrompt?: boolean;
  /** A rejected run may be retried with an empty prompt, Seedream's automatic major-elements mode (Template B). */
  emptyPromptRetry?: boolean;
};
/** Seedream layerize returns a base image plus at most 16 layers. */
export const MAX_OUTPUT_LAYERS = 17;
/** Known templates. Each has its own planner and provider prompt (layerizePlanner.ts) and its own saved prompt. */
export const TEMPLATES: TemplateDefinition[] = [{ key: 'template-a', name: 'Template A',
  description: 'Framed ad portrait: outer background, inner framed backdrop, one main subject (person or animal) holding one object (phone, board, dumbbell, product, sign).',
  fit: 'A framed portrait: one main subject (a person, child, baby or animal) shown inside a frame, with an outer background around an inner framed backdrop edged by a decorative border. The subject usually holds or shows one object; that object is optional.',
  // Every Template A run so far returned exactly these: 6 layers with the held object separate, 5 with it combined.
  layerRoles: [{ name: 'Base (clean scene)' }, { name: 'Outer background' }, { name: 'Inner backdrop' }, { name: 'Decorative border' },
    { name: 'Main subject', foreground: true }, { name: 'Held object', heldObject: true, foreground: true }],
  grouping: { label: 'Separate held object from subject', checked: 'Checked: subject and held object become separate layers.', unchecked: 'Unchecked: held object stays combined with the subject.',
    minReason: 'background, subject and held object', modeName: 'Held object mode' },
  outerBackgroundRebuild: true, normalization: 'template-a', providerPrompt: 'planned' }, { key: 'template-b', name: 'Template B',
  description: 'Single-hero product/editorial/staged composition: one clearly dominant hero object on a designed background, with optional supports, grouped decoration and secondary props.',
  fit: 'A single-hero product, editorial or staged composition: one clearly dominant hero object (such as a product, a dish of food, a piece of furniture, a lamp or a gadget) in a designed scene, possibly with supports, panels, decorative graphics and secondary props. Not a portrait centered on a person or animal, not several equally important subjects, and not a crowd or busy natural scene.',
  // Typical roles, informational only: not every poster has every role, so the suggested count comes from the decomposition.
  layerRoles: [{ name: 'Base' }, { name: 'Background' }, { name: 'Backdrop / panel' }, { name: 'Decorative graphics (grouped)' }, { name: 'Support / pedestal' },
    { name: 'Main product', foreground: true }, { name: 'Secondary object', foreground: true }, { name: 'Raster text / badge' }],
  dynamicLayerCount: true,
  // Template B's own option; it never uses Template A's held-object checkbox. Its rules: layerizeTemplateB.ts.
  options: TEMPLATE_B_OPTIONS,
  outerBackgroundRebuild: false, normalization: 'template-b', providerPrompt: 'planned', imageSpecificPrompt: true, emptyPromptRetry: true }];
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
  // Only templates with the held-object checkbox (Template A) have a separate mode; the others ignore separateHeldObject.
  const separate = !!definition.grouping && separateHeldObject;
  const roles = definition.layerRoles.filter(role => separate || !role.heldObject);
  const min = separate ? 1 + roles.filter(role => role.foreground).length : 1;
  return { min, max: definition.dynamicLayerCount ? Math.max(min, natural ?? MAX_OUTPUT_LAYERS) : roles.length };
}
/** Why a target layer count is not allowed for this template and mode, or undefined when it is. */
export function targetLayersProblem(key: string, separateHeldObject: boolean, targetLayers: number, natural?: number): string | undefined {
  const definition = requireTemplate(key), { min, max } = targetLayerRange(key, separateHeldObject, natural);
  if (!Number.isInteger(targetLayers) || targetLayers < min || targetLayers > max) {
    const why = definition.dynamicLayerCount ? (natural !== undefined ? `${max} is this decomposition's natural semantic layer count` : `${max} is Seedream's layer limit; the natural count is known after decomposition`) : `${max} is the natural semantic layer count`;
    const grouping = definition.grouping;
    if (!grouping) return `Target layers must be a whole number from ${min} to ${max} for ${definition.name} (${why}).`;
    return separateHeldObject && Number.isInteger(targetLayers) && targetLayers >= 1 && targetLayers < min
      ? `Target layers ${targetLayers} is too low for separate mode: ${grouping.minReason} need at least ${min} layers. Choose ${min}–${max}, or uncheck "${grouping.label}" to allow fewer.`
      : `Target layers must be a whole number from ${min} to ${max} for ${definition.name} in ${separateHeldObject ? 'separate' : 'combined'} mode (${why}).`;
  }
  return undefined;
}
/**
 * A run's values for its template's own options: every declared option, defaults filled in. Templates without options
 * (Template A) take none: sending one is an error, so an option can never leak into another template's run.
 */
export function templateOptionsFor(key: string, value: unknown): TemplateOptions | undefined {
  const definition = requireTemplate(key);
  const given = value === undefined || value === null ? {} : value;
  if (typeof given !== 'object' || Array.isArray(given)) throw new RunError('INVALID_TEMPLATE_OPTIONS', 'templateOptions must be an object of true/false values.');
  const declared = definition.options ?? [];
  const unknown = Object.keys(given).filter(name => !declared.some(option => option.key === name));
  if (unknown.length) throw new RunError('INVALID_TEMPLATE_OPTIONS', `${definition.name} has no option ${unknown.map(name => `"${name}"`).join(', ')}.`);
  if (!declared.length) return undefined;
  return Object.fromEntries(declared.map(option => {
    const chosen = (given as Record<string, unknown>)[option.key] ?? option.default;
    if (typeof chosen !== 'boolean') throw new RunError('INVALID_TEMPLATE_OPTIONS', `${definition.name} option "${option.key}" must be true or false.`);
    return [option.key, chosen];
  }));
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
  if (definition.imageSpecificPrompt) throw new RunError('PROMPT_NOT_REUSABLE', `${definition.name}'s prompt names one image's own layers, so it is not saved or reused as a template prompt.`);
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
